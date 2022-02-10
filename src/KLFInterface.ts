import {
  Connection,
  Gateway,
  GW_COMMAND_RUN_STATUS_NTF,
  GW_NODE_INFORMATION_CHANGED_NTF,
  GW_NODE_STATE_POSITION_CHANGED_NTF,
  IGW_FRAME_RCV, Product,
  Products,
} from "klf-200-api";
import { Disposable } from "klf-200-api/dist/utils/TypedEvent";
import { Logger } from "winston";
import { TaskCancellationPromise, TaskCancellationError } from "./utils/TaskCancellationPromise";
import { PromiseQueue } from "./utils/PromiseQueue";
import { promiseTimeout } from "./utils/promiseTimeout";

export const enum ConnectionState {
  DISCONNECTED,
  CONNECTED,
}

export interface KLFInterfaceOptions {
  hostname: string;
  password: string;
}

export class KLFInterface {
  private readonly logger: Logger;
  private readonly connection: Connection;
  private readonly gateway: Gateway;

  private readonly options: KLFInterfaceOptions;

  // The KLF can handle 2 concurrent connections and can't process requests in parallel.
  private readonly commandQueue: PromiseQueue<void>;
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

    this.commandQueue = new PromiseQueue();
    this.connectionCloseHandler = this.handleConnectionClosed.bind(this);
  }

  async setTargetPosition(productId: number, targetPosition: number): Promise<void> {
    // TODO queueu unavailable? // or wait for setup (but only certain time)?
    const product = this.products?.Products[productId];
    await product?.setTargetPositionAsync(targetPosition / 100);
  }

  async open(productId: number): Promise<void> {

  }

  async close(productId: number): Promise<void> {

  }


  async stop(productId: number): Promise<void> {

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

    // TODO work on command queue?
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
    // TODO pretty print!
    this.logger.info("Found %d products: %o", this.products.Products.length, this.products.Products.map(product => product.Name));
    this.logger.debug(`${this.products.Products}`);

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

    // TODO this.gateway.rebootAsync()
    // TODO this.connection.startKeepAlive()

    this.logger.debug("Setting up frame handler!");
    this.registeredEventHandlers.push(
      this.connection.on(this.handleReceivedFrame.bind(this)),
    );
    /*
    this.log.info(`Setting up notification handler for gateway state...`);
		this.disposables.push(this._Connection!.on(this.onFrameReceived.bind(this)));
		this.log.debug(`Frame received: ${JSON.stringify(frame)}`);
		if (!(frame instanceof GW_GET_STATE_CFM) && !(frame instanceof GW_REBOOT_CFM)) {
			// Confirmation messages of the GW_GET_STATE_REQ must be ignored to avoid an infinity loop
			await this.Setup?.stateTimerHandler(this, this.Gateway!);
		}
     */

    // TODO klf closes the connection after 15 minutes of inactivity
    // TODO this.connection.startKeepAlive(); we probably want to implement this ourselves to handle command queuing?
    //  => also handle command shifting?

    // TODO there is this custom this._Setup?.startStateTimer(); (5 * 60 * 1000,)

    setupFuture.probeCancellation();

    this.logger.debug("Setting up the watch dog close connection handler!");
    this.connectionState = ConnectionState.CONNECTED;
    this.connection.KLF200SocketProtocol!.socket.on("close", this.connectionCloseHandler);
    // TODO listen to error event to log error?
    this.logger.debug("---- KLF Interface is now considered CONNECTED ----");

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
    this.logger.debug(`Received frame: ${JSON.stringify(frame)}`);

    /*
    if (frame instanceof GW_NODE_STATE_POSITION_CHANGED_NTF) {

    } else if (frame instanceof GW_NODE_INFORMATION_CHANGED_NTF) {

    } else if (frame instanceof GW_COMMAND_RUN_STATUS_NTF) {

    }*/
  }

  private async handleConnectionClosed(hadError: boolean): Promise<void> {
    // this is our watchdog. We need to ensure that we are able to reconnect!
    this.connectionState = ConnectionState.DISCONNECTED;

    this.cleanupResources();

    if (this.isShutdown) {
      this.logger.warn("Received close event even though we are in an expected shutdown!");
    }
    this.logger.crit(`The connection to the KLF-200 Interface was lost${hadError ? "due to some error": ""}! Will reconnect!`);

    // TODO check we are not shutting down!
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

        await promiseTimeout(1000); // TODO configurable?
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

    this.products = undefined; // TODO rename method!
    // TODO other state to clear?
  }
}
