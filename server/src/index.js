/* @flow */

import Koa from 'koa';
import Raven from 'raven';
import compress from 'koa-compress';
import stoppable from 'stoppable';
import nullthrows from 'nullthrows';
import sw from './sw';
import routes from './routes';

const port = parseInt(process.env.SNACK_PORT, 10) || 3011;
const host = '::';
const backlog = 511;
const timeout = 30000;

if (require.main === module) {
  if (process.env.NODE_ENV === 'development') {
    require('source-map-support').install();
  }

  Raven.config(nullthrows(process.env.SNACK_SENTRY_DSN), {
    release: process.env.NODE_ENV === 'production' ? nullthrows(process.env.APP_VERSION) : null,
    captureUnhandledRejections: true,
    shouldSendCallback() {
      return process.env.NODE_ENV === 'production';
    },
  }).install();
}

if (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test') {
  // Use a custom koa server in production and test
  const app = new Koa();

  if (process.env.COMPRESS_ASSETS === 'true') {
    // Enable gzip compression conditionally, for development
    // This makes it easier to test how big bundles will be in production
    app.use(compress());
  }

  app.use(sw());
  app.use(routes());

  const httpServer = app.listen(port, host, backlog, () => {
    const { address, port } = server.address();

    console.log(
      `The Snack web server is listening on http://${address}:${port} in production mode`
    );
  });

  httpServer.timeout = timeout;

  // In development, it's common to stop or restart the server so we immediately end and close all
  // sockets when stopping the server instead of waiting for the requests to finish. In production,
  // we allow the requests a grace period to complete before ending and closing the sockets.
  const gracePeriod = process.env.NODE_ENV === 'development' ? 0 : httpServer.timeout;
  const server = stoppable(httpServer, gracePeriod);

  // Listen to HTTP server error events and handle shutting down the server gracefully
  let exitSignal = null;
  let httpServerError = null;

  server.on('error', error => {
    httpServerError = error;
    console.error(`There was an error with the HTTP server:`, error);
    console.error(`The HTTP server is shutting down and draining existing connections`);
    server.stop();
  });

  server.on('close', () => {
    console.log(`The HTTP server has drained all connections and is scheduling its exit`);
    console.log(`The HTTP server process is exiting...`);
    // Let other "close" event handlers run before exiting
    process.nextTick(() => {
      if (exitSignal) {
        process.kill(process.pid, exitSignal);
      } else {
        process.exit(httpServerError ? 1 : 0);
      }
    });
  });

  const shutdown = signal => {
    console.log(
      `Received ${signal}; the HTTP server is shutting down and draining existing connections`
    );
    exitSignal = signal;
    server.stop();
  };

  // TODO: In Node 9, the signal is passed as the first argument to the listener
  process.once('SIGHUP', () => shutdown('SIGHUP'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  // Nodemon sends SIGUSR2 when it restarts the process it's monitoring
  process.once('SIGUSR2', () => shutdown('SIGUSR2'));
} else {
  // Use webpack serve in development
  const serve = require('webpack-serve');
  const config = require('../../webpack.config');
  serve(
    {},
    {
      config,
      port,
      hotClient: false,
      devMiddleware: { publicPath: '/dist/' },
      add: async (app, middleware, options) => {
        app.use(sw());

        await middleware.webpack();

        app.use(routes());
      },
    }
  ).then(({ options, app }) => {
    process.once('SIGHUP', () => app.stop());
    process.once('SIGINT', () => app.stop());
    process.once('SIGTERM', () => app.stop());
    process.once('SIGUSR2', () => app.stop());
  });
}
