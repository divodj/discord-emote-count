const commandLineArgs = {
    DEBUGGING: ["--debug", "-d"],
    COLORS: ["--colors", "-c"],
};

// TODO: Make this generic when there will be too many
process.env.DEBUGGING = process.argv.some(e => commandLineArgs.DEBUGGING.includes(e));
process.env.COLORS = process.argv.some(e => commandLineArgs.COLORS.includes(e));

const auth = require("./config/auth.json");
const { bashColors: { none, blue } } = require("./lib/core/Utils");
const child_process = require("child_process");
const backgroundEnv = Object.assign({}, process.env, { BOT_TOKEN: auth.token });
const backgroundProcess = child_process.fork("./lib/Background", [], { env: backgroundEnv });
console.log("Background process PID:" + blue, backgroundProcess.pid, none);

const Client = require("./lib/Client.js");
const Database = require("./lib/core/CassandraDatabase");
Database.connect().then(() => {
    const client = new Client(auth.token, Database);
    client.connect();
});
