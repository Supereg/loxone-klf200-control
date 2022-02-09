import "source-map-support";
import { Command } from "commander";
import * as winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { WebService } from "./HTTPServer";
import { KLFInterface } from "./KLFInterface";

const enum LogLevel {
  // noinspection JSUnusedGlobalSymbols
  ERROR = "error",
  WARN = "warn",
  INFO = "info",
  HTTP = "http",
  VERBOSE = "verbose",
  DEBUG = "debug",
  SILLY = "silly",
}

function getVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const packageJSON = require("../package.json");
  return packageJSON.version;
}

const logger = winston.createLogger({
  level: LogLevel.DEBUG,
  levels: winston.config.syslog.levels,
  format: winston.format.combine(
    winston.format.splat(),
    // winston.format.ms(),
    // winston.format.timestamp(),
    winston.format.colorize(),
    // winston.format.padLevels(),
    // winston.format.label({ label: "main", message: true }),
    winston.format.errors({ stack: true }),
    winston.format.simple(),
  ),
  transports: [
    new winston.transports.Console({ level: LogLevel.DEBUG }),
    new DailyRotateFile({
      dirname: ".",
      filename: "loxone-klf-200-%DATE%.log",
      maxFiles: 5,
      createSymlink: false, // TODO toggle?
      // TODO no colorized format in the file!
    }),
  ],
});

const program = new Command();

program
  .name("loxone-klf200-control")
  .description("WebService wrapper around the Velux KL200 endpoints.")
  .version(getVersion())
  .requiredOption("-n, --hostname <hostname>", "The hostname of the Velux KLF-200 interface.")
  .requiredOption("-p --password <password>", "The password of the Velux KLF-200 interface (Identical to the WiFi password).")
  .parse();

const options = program.opts();

logger.info("------------------------------------");
logger.info("Welcome to loxone-klf-200-control v%s", getVersion());

const klfInterface = new KLFInterface(logger, { hostname: options.hostname, password: options.password });
const httpServer = new WebService(klfInterface);

// this property tracks if our shutdown handler was already called! No need to exit twice!
let shuttingDown = false;
// TODO systemd service!

// setup signal handlers
const signalHandler = (signal: NodeJS.Signals, signalNum: number): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info("Shutting down loxone-kl200-control. Got signal %s.", signal);

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

const errorHandler = (error: Error): void => {
  logger.crit("Encountered unhandled exception: %s", error);

  if (!shuttingDown) {
    process.kill(process.pid, "SIGTERM");
  }
};

process.on("SIGINT", signalHandler.bind(undefined, "SIGINT", 2));
process.on("SIGTERM", signalHandler.bind(undefined, "SIGTERM", 15));
process.on("uncaughtException", errorHandler);

// TODO When to register routes => enable queuing of commands?
httpServer.registerRoutes();

klfInterface.setup()
  .catch(errorHandler);

