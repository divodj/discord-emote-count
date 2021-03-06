const Eris = require("eris");
const _ = require("lodash");
const Database = require("./core/db/PostgreSQL");
const { parseMessage } = require("./core/EmoteParser");
const { timestampFromId, timestampToId, bashColors: { none, lightGreen, orange } } = require("./core/Utils");
const config = require("../config");

const logger = require("./core/Logger.js");
const ChannelLogger = require("./ChannelLogger.js");

class Background {
    /**
     * @param {string} token The bot's token
     * @param {Database} database The database client
     */
    constructor(token, database) {
        this.database = database;
        this.client = new Eris(token);

        // TODO: Allow enabling them individually instead of all at once
        this.client.on("error", e => logger.error(e));
        this.client.on("warn", e => logger.warn(e));
        this.client.on("debug", e => logger.debug(e));
        
        this.client.once("ready", this.setupLogs.bind(this));
        this.client.on("ready", this.onReady.bind(this));
        this.client.on("messageCreate", this.onMessageCreate.bind(this));
        this.client.on("messageUpdate", this.onMessageUpdate.bind(this));
        this.client.on("channelCreate", this.onChannelCreate.bind(this));
        this.client.on("channelUpdate", this.onChannelUpdate.bind(this));
        this.client.on("guildMemberUpdate", this.onGuildMemberUpdate.bind(this));
        this.client.on("guildCreate", guild => this.initializeGuilds([ guild ]));
        this.bucket = new Eris.Bucket(Infinity, 0);
        this.backfilledChannels = new Set();
        this.parsingChannels = new Set();
        if (process.env.DEBUGGING === "true") {
            logger.setDefaultLevel("debug");
        }
    }

    onMessageCreate(message) {
        const guild = message.channel.guild;
        if (guild && message.author) {
            const user_id = message.author.id;
            const sentAt = message.timestamp;
            const onEntry = this.database.insert.bind(this.database, guild.id, user_id, sentAt);
            const onEmote = this.onCustomEmote.bind(this);

            parseMessage(message.content, onEntry, onEmote);

            // Update the latest_parsed_id if we're done backfilling
            if (this.backfilledChannels.has(message.channel.id)) {
                this.database.updateChannel(message.channel.id, { latestParsed_id: message.id });
            }
        }
    }

    onCustomEmote(emote_id, name, isAnimated) {
        const guild = this.client.guilds.find(guild => {
            return 0 <= guild.emojis.findIndex(emoji => emoji.id === emote_id);
        });
        const guild_id = guild && guild.id;

        this.database.recordEmote(emote_id, name, isAnimated, guild_id);
    }

    async onMessageUpdate({ id, channel }) {
        const createdAt = timestampFromId(id);
        const timeSince = Date.now() - createdAt;
        if (timeSince < config.considerationPeriod) {
            const message = await channel.getMessage(id);
            const guild = channel.guild;
            if (guild && message) {
                const user_id = message.author.id;
                const sentAt = message.timestamp;
                const onEntry = this.database.insert.bind(this.database, guild.id, user_id, sentAt);
                const onEmote = this.onCustomEmote.bind(this);
                
                await this.database.delete(guild.id, user_id, sentAt);
                parseMessage(message.content, onEntry, onEmote);
            }
        }
    }

    async parseChannel(channel_id, latestParsed_id, earliestParsed_id, latestUnparsed_id) {
        const channel = this.client.getChannel(channel_id);
        if (!channel) return;
        if (!channel.guild) return;
        if (!channel.permissionsOf(this.client.user.id).has("readMessages")) return;

        let newLatestParsed_id = latestParsed_id;
        let newEarliestParsed_id = earliestParsed_id;
        let newLatestUnparsed_id = latestUnparsed_id;
        let messages;
        if (this.backfilledChannels.has(channel_id)) {
            // The "bottom" (aka oldest) messages of the channel
            messages = await channel.getMessages(100, earliestParsed_id);
            if (messages.length < 1) return; // We done!
            
            messages.forEach(m => this.onMessageCreate(m));
            newEarliestParsed_id = _.minBy(messages, "id").id;
            await this.database.updateChannel(channel_id, { earliestParsed_id: newEarliestParsed_id });
        } else {
            // The "top" (aka latest) messages of the channel
            messages = await channel.getMessages(100, latestUnparsed_id);
            messages = messages.filter(m => m.id > latestParsed_id);
            if (messages.length > 0) {
                messages.forEach(m => this.onMessageCreate(m));
    
                // Most likely always equal to `messages[message.length - 1]`, but better safe than sorry
                newLatestUnparsed_id = _.minBy(messages, "id").id;
                await this.database.updateChannel(channel_id, { latestUnparsed_id: newLatestUnparsed_id });
            }
            if (messages.length < 100) {
                this.backfilledChannels.add(channel_id);

                newLatestParsed_id = timestampToId(Date.now());
                await this.database.updateChannel(channel_id, { latestParsed_id: newLatestParsed_id });
                logger.debug("Parsed", channel.name, "from", channel.guild.name);
            }
        }

        this.queueChannel(channel_id, newLatestParsed_id, newEarliestParsed_id, newLatestUnparsed_id);
        return true;
    }

    async parseChannelWrapper(channel_id, ...args) {
        const keepGoing = await this.parseChannel(channel_id, ...args);
        
        if (keepGoing) return;
        this.parsingChannels.delete(channel_id);
        
        if (this.parsingChannels.size > 0) return;
        logger.info(orange + "Finished backfilling!", none);
    }

    queueChannel(channel_id, latestParsed_id, earliestParsed_id, latestUnparsed_id) {
        this.parsingChannels.add(channel_id);
        this.bucket.queue(this.parseChannelWrapper.bind(this, channel_id, latestParsed_id, earliestParsed_id, latestUnparsed_id));
    }

    queueChannelFromDatabase({ channel_id: rawChannel_id, latest_parsed_id, earliest_parsed_id, latest_unparsed_id }) {
        const channel_id = rawChannel_id && rawChannel_id.toString();
        const latestParsed_id = latest_parsed_id && latest_parsed_id.toString();
        const earliestParsed_id = earliest_parsed_id && earliest_parsed_id.toString();
        const latestUnparsed_id = latest_unparsed_id && latest_unparsed_id.toString();
        this.queueChannel(channel_id, latestParsed_id, earliestParsed_id, latestUnparsed_id);
    }

    async onChannelCreate(channel) {
        if (!(channel instanceof Eris.TextChannel)) return;
        if (!channel.permissionsOf(this.client.user.id).has("readMessages")) return;

        const latestUnparsed_id = timestampToId(Date.now());
        await this.database.updateChannel(channel.id, { latestUnparsed_id });

        this.queueChannel(channel.id, null, null, latestUnparsed_id);
    }

    async onChannelUpdate(channel, oldChannel) {
        const canNowRead = channel.permissionsOf(this.client.user.id).has("readMessages");
        oldChannel.guild = channel.guild;
        const couldRead = Eris.GuildChannel.prototype.permissionsOf.apply(oldChannel, [ this.client.user.id ]).has("readMessages");
        if (couldRead) return;
        if (!canNowRead) return;

        const latestUnparsed_id = timestampToId(Date.now());
        await this.database.updateChannel(channel.id, { latestUnparsed_id });

        const c = await this.database.fetchChannels([ channel.id ]);
        this.queueChannelFromDatabase(c[0]);
    }

    async onGuildMemberUpdate(guild, member, oldMember) {
        if (member.id !== this.client.user.id) return;
        if (member.roles.length === oldMember.roles.length) return;

        await this.initializeGuilds([ guild ]);
    }

    setupLogs() {
        const logChannel = this.client.getChannel(config.logChannel || "ErisIsQuality");
        if(logChannel) {
            logger.debug("Detected channel to log background client messages to.");
            this.channelLogger = new ChannelLogger(logChannel);

            logger.registerListener("info", this.onLogMessage.bind(this));
        }
    }

    onReady() {
        logger.info(lightGreen + "Background Ready!" + none);
        if (process.env.NO_BACKFILLING === "true") return;

        this.initializeGuilds(this.client.guilds.values());
    }

    async initializeGuilds(guilds) {
        const latestUnparsed_id = timestampToId(Date.now());
        const channelsToFetch = [];

        for (const guild of guilds) {
            for (const channel of guild.channels.values()) {
                if (channel instanceof Eris.TextChannel
                    && channel.permissionsOf(this.client.user.id).has("readMessages")) {
                    await this.database.updateChannel(channel.id, { latestUnparsed_id });
                    channelsToFetch.push(channel.id);
                }
            }
        }
        logger.info("Channels have been recorded! Starting the queue.");

        const channels = await this.database.fetchChannels(channelsToFetch);
        logger.info("Fetched", channels.length, "channels");
        channels.forEach(this.queueChannelFromDatabase.bind(this));
    }

    onLogMessage(packet) {
        this.channelLogger.logToChannel(packet);
    }

    connect() {
        this.client.connect();
    }
}

Database.connect({}).then(() => {
    const background = new Background(process.env.EMOTE_BOT_TOKEN, Database);
    background.connect();
});
