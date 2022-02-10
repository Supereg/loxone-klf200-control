import {
  Connection,
  Gateway, GatewayCommand,
  GatewayState,
  GatewaySubState, GW_ERROR, GW_ERROR_NTF,
  GW_NODE_STATE_POSITION_CHANGED_NTF,
  IGW_FRAME_RCV,
  Product,
  Products,
  RunStatus,
  StatusReply,
} from "klf-200-api";
import { Disposable } from "klf-200-api/dist/utils/TypedEvent";
import { Logger } from "winston";
import { CommandSessionEvent, RunCommandSession } from "./RunCommandSession";
import { promisedWait } from "./utils/promisedWait";
import { PromiseQueue, PromiseQueueElement } from "./utils/PromiseQueue";
import { TaskCancellationError, TaskCancellationPromise } from "./utils/TaskCancellationPromise";

export const enum ConnectionState {
  DISCONNECTED,
  CONNECTED,
}

export interface KLFInterfaceOptions {
  hostname: string;
  password: string;
}

export class KLFInterface {
  private static readonly keepAliveTimoutInterval = 5 * 60 * 1000;
  // TODO do we need a gateway reboot scheduler?

  readonly logger: Logger;
  private readonly connection: Connection;
  private readonly gateway: Gateway;

  private readonly options: KLFInterfaceOptions;

  // The KLF can handle 2 concurrent connections and can't process requests in parallel.
  private readonly commandQueue: PromiseQueue;
  private readonly registeredEventHandlers: Disposable[] = [];
  private readonly connectionCloseHandler: (hadError: boolean) => Promise<void>;

  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private isShutdown = true;
  private keepAliveTimeout?: NodeJS.Timeout;
  private products?: Products;

  /**
   * The `setup()` call may take several seconds. We want to give the outside to give control to cancel this operation.
   * But at the same time, this cancellation should only happen in a controlled manner were the `setup()` call
   * exists with a controlled and expected state. This is all handled through the `TaskCancellationPromise`.
   * If this property is defined, there is a `setup` call ongoing.
   * You can use {@link TaskCancellationPromise.cancel} method to request the cancellation of the setup procedure and wait for the returned Promise.
   * In EVERY case, there will be a successfully established connection afterwards. Meaning the earliest point setup can cancel if
   * after `loginAsync` returns (`loginAsync` may also return with an error, then there is no established connection).
   */
  private setupFuture?: TaskCancellationPromise;

  constructor(logger: Logger, options: KLFInterfaceOptions) {
    this.logger = logger.child({});
    this.connection = new Connection(options.hostname); // TODO CA + Fingerprint
    // gateway must not be accessed till `setup` was called!
    this.gateway = new Gateway(this.connection);

    this.options = options;

    this.commandQueue = new PromiseQueue(this.logger);
    this.connectionCloseHandler = this.handleConnectionClosed.bind(this);
  }

  public async awaitProductAvailability(productId: number): Promise<Product> {
    if (this.setupFuture) {
      await this.setupFuture.awaitCompletion();
      // awaiting completion can also mean the task has been cancelled, therefore
      // we still need to check if products is actually available!
    }

    if (!this.products) {
      // There is no good reason to wait e.g. for a reconnect. If it failed already one time it might fail a second time.
      // And connecting usually takes way to long, making the command obsolete anyway!
      throw new Error("Connection to the KLF-200 Interface seems to be lost. Please try again in a few seconds!");
    }

    const product = this.products.Products[productId];
    if (!product) {
      // TODO throw 404 instead
      throw new Error(`Product ${productId} could not be found!`);
    }

    return product;
  }

  public enqueueCommand<T>(command: PromiseQueueElement<T>): Promise<T> {
    return this.commandQueue.push(command);
  }

  // TODO can we override the rain sensor?

  async open(productId: number): Promise<RunCommandSession> {
    // TODO flicker light if we reached limit due to rain sensor!

    // TODO timeout of 10 seconds is a bit long?
    const context = await RunCommandSession.executeCommand(
      this,
      productId,
      // this is a bit weird, but we are basically producing a double closure.
      // a closure that produces the closure which actually executes the command.
      product => () => product.setTargetPositionAsync(1),
    );

    // wait for the first run_status_notification
    const [status, reply] = await context.once(CommandSessionEvent.RUN_STATUS); // TODO timeout RUN_STATUS?
    if (status === RunStatus.ExecutionFailed) {
      throw new Error(`Execution failed: ${StatusReply[reply]}`);
    }

    context.once(CommandSessionEvent.SESSION_FINISHED).then(() => {
      // TODO if statusReply isn't OVERRULED(or does rain sensor set something?) => check if the target position is the expceted one!
      //   (e.g. => StatusReply.LimitationByRain)
    });

    return context;
  }

  async close(productId: number): Promise<RunCommandSession> {
    const context = await RunCommandSession.executeCommand(
      this,
      productId,
      product => () => product.setTargetPositionAsync(0),
    );

    // wait for the first run_status_notification
    const [status, reply] = await context.once(CommandSessionEvent.RUN_STATUS);
    if (status === RunStatus.ExecutionFailed) {
      throw new Error(`Execution failed: ${StatusReply[reply]}`);
    }

    return context;
  }


  async stop(productId: number): Promise<RunCommandSession> {
    const context = await RunCommandSession.executeCommand(
      this,
      productId,
      product => () => product.stopAsync(),
    );

    // wait for the first run_status_notification
    const [status, reply] = await context.once(CommandSessionEvent.RUN_STATUS);
    if (status === RunStatus.ExecutionFailed) {
      throw new Error(`Execution failed: ${StatusReply[reply]}`);
    }

    return context;
  }

  async setup(): Promise<void> {
    if (this.setupFuture) {
      await this.setupFuture.awaitCompletion();
      return;
    }

    this.isShutdown = false;

    // The `TaskCancellationPromise` is essential, look above for documentation!
    this.setupFuture = new TaskCancellationPromise();

    try {
      await this._setupCall(this.setupFuture);

      this.setupFuture.confirmCompletion();
    } catch (error) {
      if (error instanceof TaskCancellationError) {
        this.setupFuture.confirmCancellation();
        this.logger.info(`KLF-200 logon was cancelled with reason: ${error.reason}`);

        // we don't want to inject unnecessary errors into potential callers (e.g. the WatchDog doing a reconnect).
        // Therefore, we just return gracefully. This works HERE. Might not be the best decision in every scenario!
        return;
      }

      throw error;
    } finally {
      this.setupFuture = undefined;
    }
  }

  private async _setupCall(setupFuture: TaskCancellationPromise): Promise<void> {
    this.logger.debug("---- Starting to setup the KLF Interface ----");
    this.logger.info("Logging into the KLF 200 Interface...");
    await this.connection.loginAsync(this.options.password);

    setupFuture.probeCancellation();

    this.logger.debug("Enabling the House Status Monitor...");
    await this.gateway.enableHouseStatusMonitorAsync();

    setupFuture.probeCancellation();

    this.logger.debug("Ensuring time and date is consistent...");
    await this.gateway.setUTCDateTimeAsync();

    setupFuture.probeCancellation();

    this.logger.debug("Setting the time zone...");
    await this.gateway.setTimeZoneAsync(":GMT+1:GMT+2:0060:(1994)040102-0:110102-0"); // TODO in theory configureable?
    // TODO expect GatewayMode_WithActuatorNodes

    setupFuture.probeCancellation();

    this.logger.debug("Querying the products list from the gateway...");
    this.products = await Products.createProductsAsync(this.connection);

    this.logger.info("Found %d products: %s",
      this.products.Products.length, this.products.Products.map(product => `{id: ${product.NodeID}, name: "${product.Name}"}`));
    this.logger.verbose(JSON.stringify(this.products.Products));

    // TODO Gateway State!
    // "GatewaySubState - This state shows if the gateway is currently idle or if it's running a command, a scene of if it's currently in a configuration mode."

    setupFuture.probeCancellation();

    this.registeredEventHandlers.push(this.products.onNewProduct(productId => {
      const product = this.products?.Products[productId];
      if (product) {
        this.logger.info(`New product ${product.Name} with id ${productId} was added to the KLF-200 Interface!`);
      } else {
        this.logger.info(`New product with id ${productId} was added to the KLF-200 Interface!`);
      }
    }));

    this.registeredEventHandlers.push(this.products.onRemovedProduct(productId => {
      this.logger.info(`Product with id ${productId} was removed from the KLF-200 Interface!`);
    }));

    this.logger.debug("Setting up frame handler!");
    this.registeredEventHandlers.push(
      this.connection.on(this.handleReceivedFrame.bind(this)),
    );

    setupFuture.probeCancellation();

    this.logger.debug("Setting up the connection watch dog!");
    this.connectionState = ConnectionState.CONNECTED;
    this.connection.KLF200SocketProtocol!.socket.on("close", this.connectionCloseHandler);
    // TODO listen to error event to log error?

    this.scheduleKeepAliveTimeout();

    this.logger.debug("---- KLF Interface is now considered CONNECTED ----");

    // TODO register property change
    // TODO register property change on new product!

    /*
    TODO tests
    for (const product of this.products.Products) {
      product.propertyChangedEvent.on(event => {
        if (!(event.o instanceof Product)) {
          return; // just necessary so we have proper typing!
        }

        if (event.propertyName === "TargetPosition") {
          this.logger.debug(`TargetPosition of ${event.o.Name} changed to ${event.propertyValue}`);
        }

        // "TargetPositionRaw" / "TargetPosition"
      });
    }*/
  }

  async shutdown(): Promise<void> {
    // check if there is a `setup()` still running. If so, cancel it and wait for it.
    if (this.setupFuture) {
      await this.setupFuture.cancel("shutdown");
    }

    this.isShutdown = true;
    this.cleanupResources(); // ensure resources are cleaned up, especially as we potentially have cancelled a `setup()` call!

    if (!this.connection.KLF200SocketProtocol) {
      return; // we aren't connected
    }

    this.logger.info("Shutting down the connection to the KLF-200 Interface.");
    try {
      await this.connection.logoutAsync();

      this.logger.info("Logged out successfully.");
    } catch (error) {
      this.logger.warn("We failed to log out from the KLF-200 Interface: %s", error);
    }
  }

  private handleReceivedFrame(frame: IGW_FRAME_RCV): void {
    this.logger.verbose(`Received frame ${GatewayCommand[frame.Command] ?? "?"}: ${JSON.stringify(frame)}`);

    if (frame instanceof GW_NODE_STATE_POSITION_CHANGED_NTF) {
      // TODO in theory we only need a property listener on the `targetProperty` right? (and check if this was caused by on ongoing command?)
      // TODO if this isn't triggered by us this is triggered by the rain sensor(?) or by a remote
      //  -> reflect this state change in loxone!
    } else if (frame instanceof GW_ERROR_NTF) {
      // Typically, such a frame will be sent after any REQ frame and the respective promise will be rejected. We just capture this to log it.
      this.logger.error(`The KLF-200 Interface returned a ERROR NOTIFICATION with error ${GW_ERROR[frame.ErrorNumber]}`);
    }
  }

  private async handleConnectionClosed(hadError: boolean): Promise<void> {
    // this is our watchdog. We need to ensure that we are able to reconnect!
    this.connectionState = ConnectionState.DISCONNECTED;

    this.cleanupResources();

    if (this.isShutdown) {
      this.logger.warn("Received close event even though we are in an expected shutdown!");
    }
    this.logger.crit(`The connection to the KLF-200 Interface was lost${hadError ? "due to some error": ""}! Will reconnect!`);

    while (!this.isShutdown) {
      this.logger.debug("Trying to reconnect...");
      try {
        // connectionState will be set in setup!
        await this.setup();
        // setup may return regularly even though it was cancelled. This is fine with use though!
        // If a setup was explicitly cancelled, we also want to abort the reconnect loop.

        // break the loop we succeeded
        break;
      } catch (error) {
        this.logger.error(`Login attempt to KLF-200 Interface at ${this.options.hostname} failed: %s`, error);
        this.logger.warn("Retrying login in 1 second...");

        await promisedWait(1000);
      }
    }
  }

  private cleanupResources(): void {
    if (this.connection.KLF200SocketProtocol) {
      this.connection.KLF200SocketProtocol.socket.off("close", this.connectionCloseHandler);
    } else if (!this.isShutdown) {
      this.logger.warn("Tried to cleanup 'close' event handler, though the connection socket wasn't accessible anymore!");
    }

    for (const disposable of this.registeredEventHandlers) {
      disposable.dispose();
    }

    this.products = undefined;
    this.resetKeepAliveTimeout();
  }

  public scheduleKeepAliveTimeout(): void {
    this.resetKeepAliveTimeout();

    this.keepAliveTimeout = setInterval(this.handleKeepAliveTimeoutTrigger.bind(this), KLFInterface.keepAliveTimoutInterval);
  }

  private resetKeepAliveTimeout() {
    if (this.keepAliveTimeout) {
      try {
        clearInterval(this.keepAliveTimeout);
      } finally {
        this.keepAliveTimeout = undefined;
      }
    }
  }

  private handleKeepAliveTimeoutTrigger() {
    // noinspection JSIgnoredPromiseFromCall
    this.commandQueue.push(async () => {
      try {
        const gatewayState = await this.gateway.getStateAsync();

        this.logger.debug("Current gateway status '%s' and sub-status '%s'.", GatewayState[gatewayState.GatewayState], GatewaySubState[gatewayState.SubState]);
      } catch (error) {
        this.logger.warn("Encountered error while retrieving gateway status: %s", error instanceof Error ? error.message : error);
      }
    });
  }
}
