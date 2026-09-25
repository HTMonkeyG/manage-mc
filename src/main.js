const App = require("./ui/app");

/**
 * Start the application.
 *
 * A failure inside the render loop must still restore the terminal, otherwise
 * the alternate screen would be left active over the shell.
 * @returns {Promise<void>}
 */
async function main() {
  var app = new App();

  process.on("uncaughtException", error => {
    app.tui.stop();
    console.error(error);
    process.exit(1);
  });

  process.on("unhandledRejection", error => {
    app.tui.stop();
    console.error(error);
    process.exit(1);
  });

  await app.run();
}

main().catch(error => {
  console.error(error && error.message ? error.message : error);
  process.exit(1);
});
