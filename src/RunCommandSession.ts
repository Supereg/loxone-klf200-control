import { EventEmitter, once } from "events";
import {
  GatewayCommand,
  GW_COMMAND_REMAINING_TIME_NTF,
  GW_COMMAND_RUN_STATUS_NTF,
  GW_SESSION_FINISHED_NTF,
  Product,
  RunStatus,
  StatusReply,
} from "klf-200-api";
import { IGW_FRAME_RCV } from "klf-200-api/dist/KLF200-API/common";
import { Disposable } from "klf-200-api/dist/utils/TypedEvent";
import { Logger } from "winston";
import { KLFInterface } from "./KLFInterface";
import { PromiseQueueElement } from "./utils/PromiseQueue";

export type SessionId = number;

export const enum CommandSessionEvent {
  RUN_STATUS = "run-status",
  REMAINING_TIME = "remaining-time",
  SESSION_FINISHED = "session-finished",
}

declare interface CommandSessionEventEmitter {
  emit(eventName: CommandSessionEvent.RUN_STATUS, status: RunStatus, reply: StatusReply): boolean;
  emit(eventName: CommandSessionEvent.REMAINING_TIME, remainingTime: number): boolean;
  emit(eventName: CommandSessionEvent.SESSION_FINISHED): boolean;
}

class CommandSessionEventEmitter extends EventEmitter {
  constructor() {
    super();
  }
}

export class RunCommandSession {
  private readonly logger: Logger;
  readonly sessionID: SessionId;
  private readonly frameHandlerDisposable: Disposable;
  private readonly emitter: CommandSessionEventEmitter;

  private lastStatus?: RunStatus;
  private lastReplay?: StatusReply;

  constructor(logger: Logger, sessionID: SessionId, product: Product) {
    this.logger = logger;
    this.sessionID = sessionID;
    this.frameHandlerDisposable = product.Connection.on(this.handleReceivedFrame.bind(this), [
      GatewayCommand.GW_COMMAND_RUN_STATUS_NTF,
      GatewayCommand.GW_COMMAND_REMAINING_TIME_NTF,
      GatewayCommand.GW_SESSION_FINISHED_NTF,
    ]);

    this.emitter = new CommandSessionEventEmitter();
  }

  public once(event: CommandSessionEvent.RUN_STATUS): Promise<[status: RunStatus, reply: StatusReply]>;
  public once(event: CommandSessionEvent.REMAINING_TIME): Promise<[remainingTime: number]>;
  public once(event: CommandSessionEvent.SESSION_FINISHED): Promise<[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public once(event: CommandSessionEvent): Promise<any[]> {
    return once(this.emitter, event);
  }

  private handleReceivedFrame(frame: IGW_FRAME_RCV): void {
    if (frame instanceof GW_COMMAND_RUN_STATUS_NTF) {
      this.lastStatus = frame.RunStatus;
      this.lastReplay = frame.StatusReply;

      // eslint-disable-next-line max-len
      this.logger.debug(`Command ${this.sessionID} received status update: status ${RunStatus[frame.RunStatus]}, reply ${StatusReply[frame.StatusReply]}, value: ${frame.ParameterValue}`);

      // TODO we are not forwarding ParameterValue(?)
      this.emitter.emit(CommandSessionEvent.RUN_STATUS, frame.RunStatus, frame.StatusReply);
    } else if (frame instanceof GW_COMMAND_REMAINING_TIME_NTF) {
      this.emitter.emit(CommandSessionEvent.REMAINING_TIME, frame.RemainingTime);
    } else if (frame instanceof GW_SESSION_FINISHED_NTF) {
      // this command finished! Don't listen on further events.
      this.frameHandlerDisposable.dispose();
      // eslint-disable-next-line max-len
      this.logger.info(`Finished command ${this.sessionID} with status ${this.lastStatus != null ? RunStatus[this.lastStatus]: "?"} and reply ${this.lastReplay != null ? StatusReply[this.lastReplay] : "?"}!`);

      this.emitter.emit(CommandSessionEvent.SESSION_FINISHED);
    }
  }

  static async executeCommand(
    klfInterface: KLFInterface,
    productId: number,
    commandProducing: (product: Product) => PromiseQueueElement<SessionId>,
    commandName?: string,
  ): Promise<RunCommandSession> {
    const product = await klfInterface.awaitProductAvailability(productId);

    // we wait for the initial command CFM frame. Only then create the command session
    // to expect further frames like RUN_STATUS_NTF or the FINISHED_NFT.
    // This call might fail, if the Interface can't execute the command.
    // This command will not fail if the actuator can't execute the command (this is signaled through RUN_STATUS).
    console.log(`${commandProducing}`);
    let sessionId: number;
    try {
      sessionId = await klfInterface.enqueueCommand(commandProducing(product));
      klfInterface.logger.info(`Command session established with id ${sessionId}!`);
    } catch (error) {
      klfInterface.logger.info("Establishing command session failed with: %s", error instanceof Error ? error.message : error);
      throw error;
    }

    klfInterface.scheduleKeepAliveTimeout(); // reset timeout interval, we just sent a command!

    return new RunCommandSession(klfInterface.logger, sessionId, product);
  }
}
