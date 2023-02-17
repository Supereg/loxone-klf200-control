import { Command, InvalidArgumentError } from "commander";
import "source-map-support";
import * as winston from "winston";
import { Logger } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { AbstractConfigSetLevels } from "winston/lib/winston/config";
import { KLFInterface } from "./KLFInterface";
import { WebService } from "./WebService";

function getVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJSON = require("../package.json");
  return packageJSON.version;
}

const levels: AbstractConfigSetLevels = {
  emerg: 0,
  alert: 1,
  crit: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
  verbose: 8,
};

const colors: Record<string, string> = {
  emerg: "red",
  alert: "yellow",
  crit: "red",
  error: "red",
  warning: "yellow",
  notice: "cyan",
  info: "green",
  debug: "blue",
  verbose: "grey",
};

const formats = [
  winston.format.splat(),
  winston.format.ms(),
  winston.format.timestamp({ format: "YYYY-MM-DD hh:mm:ss.SSS" }),
  winston.format.errors({ stack: true }),
];

const printf = winston.format.printf(info => {
  return `${info.timestamp} ${info.level}: [${info.label ?? "main"}] ${info.message}  ${info.ms}`;
});

function createLogger(level: string): Logger {
  return winston.createLogger({
    level: level,
    levels: levels,
    transports: [
      new winston.transports.Console({
        level: level,
        format: winston.format.combine(
          ...formats,
          winston.format.colorize({ colors: colors }),
          printf,
        ),
      }),
      new DailyRotateFile({
        dirname: ".",
        filename: "loxone-klf-200-%DATE%.log",
        maxFiles: 10,
        createSymlink: false, // TODO toggle?
        format: winston.format.combine(
          ...formats,
          printf,
        ),
      }),
    ],
  });
}

function parseSafeInt(value: string): number {
  // parseInt takes a string and a radix
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new InvalidArgumentError("Not a number.");
  }
  return parsedValue;
}

const program = new Command();

program
  .name("loxone-klf200-control")
  .description("WebService wrapper around the Velux KL200 endpoints.")
  .version(getVersion())
  .requiredOption("-n, --hostname <hostname>", "The hostname of the Velux KLF-200 interface.")
  .requiredOption("-p --password <password>", "The password of the Velux KLF-200 interface (Identical to the WiFi password).")
  .option("-b --bind <port>", "The port the http web service binds on!", parseSafeInt, 8080)
  .option("-l --log-level <level>",
    "The desired log level. Default `debug` (Available: `verbose`, `debug`, `info`, `notice`, `warning`, `error`, `crit`).",
    "debug")
  .parse();

const options = program.opts();

const logger = createLogger(options.logLevel);
logger.info("------------------------------------");
logger.info("Welcome to loxone-klf-200-control v%s", getVersion());

const klfInterface = new KLFInterface(logger, { hostname: options.hostname, password: options.password });
const httpServer = new WebService(logger, klfInterface);

// this property tracks if our shutdown handler was already called! No need to exit twice!
let shuttingDown = false;
// TODO systemd service!

const shutdownHandler = (signalNum = 0): void => {
  httpServer
    .shutdown()
    .catch(reason => logger.error("Failed to shutdown web service: %s", reason))
    .then(() => klfInterface.shutdown())
    .catch(reason => logger.error("Failed to shutdown the KLF-200 Interface: %s", reason))
    .then(() => {
      logger.info("Bye!");
      logger.close();
      process.exit(128 + signalNum); // TODO exit gracefully?
    });
};

const signalHandler = (signal: NodeJS.Signals, signalNum: number): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info("Shutting down loxone-kl200-control. Got signal %s.", signal);
  shutdownHandler(signalNum);
};

const errorHandler = (error: Error): void => {
  logger.crit("Encountered unhandled exception: %s", error);

  if (!shuttingDown) {
    process.kill(process.pid, "SIGTERM");
  }
};

process.on("SIGINT", signalHandler.bind(undefined, "SIGINT", 2));
process.on("SIGTERM", signalHandler.bind(undefined, "SIGTERM", 15));
process.on("uncaughtException", errorHandler);

httpServer
  .listen(options.bind)
  .then(() => klfInterface.setup())
  .catch(reason => {
    logger.verbose("Reached end of setup promise chain with error reason %s", reason);
    logger.info("First KLF-200 setup call was unsuccessful (%s). Shutting down the application...", reason?.message ?? reason);

    shutdownHandler();
  });

