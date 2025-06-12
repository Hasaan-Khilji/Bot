// Import necessary modules from discord.js, Node.js file system, and node-cron
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, EmbedBuilder } = require('discord.js');
const fs = require('node:fs/promises'); // Use promises version for async file operations
const cron = require('node-cron'); // For scheduling daily resets

// --- Bot Configuration ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
    ],
    partials: ['CHANNEL', 'MESSAGE', 'USER', 'GUILD_MEMBER'],
});

// --- Data File Configuration ---
const DATA_FILE = './bot_data.json';
const TARGET_CHANNEL_ID = process.env.CHANNEL_ID;
const SHOP_CHANNEL_ID = process.env.SHOP_CHANNEL_ID;
const CHAT_CHANNEL_ID = process.env.CHAT_CHANNEL_ID;
const USE_ITEMS_CHANNEL_ID = process.env.USE_ITEMS_CHANNEL_ID;
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID;

// --- Task & Reward Definitions ---
const FIXED_DAILY_TASKS = ["Fajr", "Zuhr", "Asr", "Maghrib", "Ish'a", "Qur'an"];
const TALK_SHARD_NAME = "Talk Shard";
const MLBB_SHARD_NAME = "MLBB Shard";
const TALK_PASS_NAME = "Talk Pass";
const MLBB_PASS_NAME = "MLBB Pass";
const NEGATIVE_SHARD_NAME = "Negative Shard";

const ITEM_EMOJIS = {
    [TALK_SHARD_NAME]: "🧩",
    [MLBB_SHARD_NAME]: "🧩",
    [TALK_PASS_NAME]: "🎫",
    [MLBB_PASS_NAME]: "🎟️",
    [NEGATIVE_SHARD_NAME]: "💔"
};

const MAIN_GROUP_REWARD_ITEM = TALK_SHARD_NAME;
const SPECIAL_TASK_REWARD_ITEM = MLBB_SHARD_NAME;
const ALL_VALID_ITEMS = [TALK_SHARD_NAME, MLBB_SHARD_NAME, TALK_PASS_NAME, MLBB_PASS_NAME, NEGATIVE_SHARD_NAME];

// --- In-memory Data Storage ---
let dailyTasksMessageData = {};
let publicShopMessageData = {};
let useItemsMessageData = {};
let userData = {};
let chatChannelState = { isUnlocked: false, unlockedBy: null, unlockedDate: null };

// --- Helper Functions ---
function getItemDisplay(itemName) {
    return `${itemName} ${ITEM_EMOJIS[itemName] || ''}`.trim();
}

function getItemDisplayWithQuantity(itemName, quantity) {
    return `${itemName} ${ITEM_EMOJIS[itemName] || ''} x${quantity}`.trim();
}

async function sendDM(userId, message) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(message);
    } catch (error) {
        console.error(`Could not send DM to user ${userId}:`, error);
    }
}

async function deleteMessageSafe(channel, messageId, description = 'message') {
    if (!channel || !messageId) return;
    try {
        const msg = await channel.messages.fetch(messageId);
        await msg.delete();
    } catch (err) {
        if (err.code !== 10008) { // Ignore "Unknown Message" error
            console.warn(`Could not delete ${description} (${messageId}):`, err);
        }
    }
}

// --- File & Data Operations ---
async function loadData() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const parsedData = JSON.parse(data);
        dailyTasksMessageData = parsedData.dailyTasksMessageData || {};
        publicShopMessageData = parsedData.publicShopMessageData || {};
        useItemsMessageData = parsedData.useItemsMessageData || {};
        userData = parsedData.userData || {};
        chatChannelState = parsedData.chatChannelState || { isUnlocked: false, unlockedBy: null, unlockedDate: null };
        console.log('Data loaded successfully.');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('bot_data.json not found, initializing with empty data.');
            userData = {};
        } else {
            console.error('Error loading data:', error);
            dailyTasksMessageData = {};
            publicShopMessageData = {};
            useItemsMessageData = {};
            userData = {};
            chatChannelState = { isUnlocked: false, unlockedBy: null, unlockedDate: null };
        }
    }
    for (const userId in userData) {
        const user = userData[userId];
        user.pass_usage_by_date = user.pass_usage_by_date || {};
        user.negative_shards = user.negative_shards ?? 0;
        if (typeof user.talk_shards_count !== 'number') {
            user.talk_shards_count = (user.items || []).filter(item => item === TALK_SHARD_NAME).length;
            user.items = (user.items || []).filter(item => item !== TALK_SHARD_NAME);
        }
    }
    if (Object.keys(userData).length > 0) await saveData();
}

async function saveData() {
    try {
        await fs.writeFile(DATA_FILE, JSON.stringify({ dailyTasksMessageData, publicShopMessageData, useItemsMessageData, userData, chatChannelState }, null, 2), 'utf8');
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

function getFormattedDate(offsetDays = 0) {
    const date = new Date();
    date.setDate(date.getDate() - offsetDays);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const getTodayDate = () => getFormattedDate(0);
const getYesterdayDate = () => getFormattedDate(1);
const getTwoDaysAgoDate = () => getFormattedDate(2);

async function getOrCreateUserData(userId) {
    if (!userData[userId]) {
        userData[userId] = {
            completed_tasks_by_date: {},
            items: [],
            daily_rewards_claimed: {},
            pass_usage_by_date: {},
            negative_shards: 0,
            talk_shards_count: 0,
            discordUserId: userId
        };
        await saveData();
    }
    return userData[userId];
}

async function addItemToUser(userId, item, quantity = 1) {
    const user = await getOrCreateUserData(userId);
    if (item === NEGATIVE_SHARD_NAME) user.negative_shards += quantity;
    else if (item === TALK_SHARD_NAME) user.talk_shards_count += quantity;
    else {
        for (let i = 0; i < quantity; i++) user.items.push(item);
    }
    await saveData();
}

async function removeItemsFromUser(userId, itemToRemove, quantity) {
    const user = await getOrCreateUserData(userId);
    if (itemToRemove === TALK_SHARD_NAME) {
        user.talk_shards_count -= quantity;
        await saveData();
        return true;
    }
    if (itemToRemove === NEGATIVE_SHARD_NAME) {
        user.negative_shards = Math.max(0, user.negative_shards - quantity);
        await saveData();
        return true;
    }

    let removedCount = 0;
    const newItems = [];
    for (const item of user.items) {
        if (item === itemToRemove && removedCount < quantity) {
            removedCount++;
        } else {
            newItems.push(item);
        }
    }

    if (removedCount === quantity) {
        user.items = newItems;
        await saveData();
        return true;
    }
    return false;
}

async function setItemsForUser(userId, itemToSet, quantity) {
    const user = await getOrCreateUserData(userId);
    if (itemToSet === NEGATIVE_SHARD_NAME) user.negative_shards = quantity;
    else if (itemToSet === TALK_SHARD_NAME) user.talk_shards_count = quantity;
    else {
        user.items = user.items.filter(item => item !== itemToSet);
        for (let i = 0; i < quantity; i++) user.items.push(itemToSet);
    }
    await saveData();
    return true;
}

function countUserItem(userId, itemName) {
    const user = userData[userId];
    if (!user) return 0;
    if (itemName === NEGATIVE_SHARD_NAME) return user.negative_shards ?? 0;
    if (itemName === TALK_SHARD_NAME) return user.talk_shards_count ?? 0;
    return user.items.filter(item => item === itemName).length;
}

// --- Message Generation & Sending ---
function generateDailyTaskListMessage(date, allUserData) {
    let content = `**__Daily To-Do List for ${date}__**\n\nClick a button to mark a task as complete for yourself!\n\n`;
    content += `**Main Tasks (Complete all 5 for: ${getItemDisplay(MAIN_GROUP_REWARD_ITEM)})**\n`;
    for (let i = 0; i < 5; i++) {
        const task = FIXED_DAILY_TASKS[i];
        const completers = Object.keys(allUserData)
            .filter(userId => allUserData[userId].completed_tasks_by_date[date]?.includes(i))
            .map(userId => `<@${userId}>`);
        content += `**${i + 1}. ${task}**\n> ${completers.length > 0 ? `Completed by: ${completers.join(', ')}` : 'No one has completed this yet.'}\n`;
    }

    content += `\n-----------------------------------\n\n`;
    const specialTaskIndex = 5;
    content += `**Special Task (Complete for: ${getItemDisplay(SPECIAL_TASK_REWARD_ITEM)})**\n`;
    const specialCompleters = Object.keys(allUserData)
        .filter(userId => allUserData[userId].completed_tasks_by_date[date]?.includes(specialTaskIndex))
        .map(userId => `<@${userId}>`);
    content += `**${specialTaskIndex + 1}. ${FIXED_DAILY_TASKS[specialTaskIndex]}**\n> ${specialCompleters.length > 0 ? `Completed by: ${specialCompleters.join(', ')}` : 'No one has completed this yet.'}\n`;

    const row1 = new ActionRowBuilder();
    const row2 = new ActionRowBuilder();
    FIXED_DAILY_TASKS.forEach((task, index) => {
        const button = new ButtonBuilder().setCustomId(`complete_task_${index}_${date}`).setLabel(task).setStyle(ButtonStyle.Primary);
        (index < 5 ? row1 : row2).addComponents(button);
    });

    return { content, components: [row1, row2] };
}

function generateShopMessage(userId) {
    const shopContent = `**__Welcome to the Shop!__**\n\n`
                      + `Trade your hard-earned items here!\n\n`
                      + `**Available Trades:**\n`
                      + `1. Trade 7 ${getItemDisplay(TALK_SHARD_NAME)} for 1 ${getItemDisplay(TALK_PASS_NAME)}\n`
                      + `2. Trade 3 ${getItemDisplay(MLBB_SHARD_NAME)} for 1 ${getItemDisplay(MLBB_PASS_NAME)}\n`
                      + `3. Trade 2 ${getItemDisplay(MLBB_PASS_NAME)} for 1 ${getItemDisplay(TALK_PASS_NAME)}\n\n`
                      + `Your inventory:\n`
                      + `  ${getItemDisplayWithQuantity(TALK_SHARD_NAME, countUserItem(userId, TALK_SHARD_NAME))}\n`
                      + `  ${getItemDisplayWithQuantity(MLBB_SHARD_NAME, countUserItem(userId, MLBB_SHARD_NAME))}\n`
                      + `  ${getItemDisplayWithQuantity(TALK_PASS_NAME, countUserItem(userId, TALK_PASS_NAME))}\n`
                      + `  ${getItemDisplayWithQuantity(MLBB_PASS_NAME, countUserItem(userId, MLBB_PASS_NAME))}`;

    const tradeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trade_talk_shards_to_talk_pass').setLabel(`Trade 7 ${getItemDisplay(TALK_SHARD_NAME)} for 1 ${getItemDisplay(TALK_PASS_NAME)}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trade_mlbb_shards_to_mlbb_pass').setLabel(`Trade 3 ${getItemDisplay(MLBB_SHARD_NAME)} for 1 ${getItemDisplay(MLBB_PASS_NAME)}`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('trade_mlbb_pass_to_talk_pass').setLabel(`Trade 2 ${getItemDisplay(MLBB_PASS_NAME)} for 1 ${getItemDisplay(TALK_PASS_NAME)}`).setStyle(ButtonStyle.Primary),
    );
    const dismissRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dismiss_shop').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
    return { content: shopContent, components: [tradeRow, dismissRow] };
}

async function sendDailyTaskList(channel, introMessageContent = null) {
    const todayDate = getTodayDate();
    const { content, components } = generateDailyTaskListMessage(todayDate, userData);
    try {
        let introMessageId = introMessageContent ? (await channel.send(introMessageContent)).id : null;
        const sentMessage = await channel.send({ content, components });
        dailyTasksMessageData[todayDate] = { introMessageId, messageId: sentMessage.id };
        await saveData();
        console.log(`Daily tasks message sent/updated for ${todayDate} in channel ${channel.id}`);
    } catch (error) {
        console.error(`Failed to send daily tasks message:`, error);
    }
}

async function postShopMessage() {
    try {
        const channel = await client.channels.fetch(SHOP_CHANNEL_ID);
        if (!channel || channel.type !== ChannelType.GuildText) return;
        const today = getTodayDate();
        const content = `**__Today's Bazaar is Open!__**\n\nClick the button below to view trades and your personal inventory.`;
        const components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_personal_shop').setLabel('Visit My Personal Shop').setStyle(ButtonStyle.Success))];
        const sentMessage = await channel.send({ content, components });
        publicShopMessageData[today] = { messageId: sentMessage.id };
        await saveData();
    } catch (e) { console.error("Failed to post shop message:", e) }
}

async function postUseItemsMessage() {
    try {
        const channel = await client.channels.fetch(USE_ITEMS_CHANNEL_ID);
        if (!channel || channel.type !== ChannelType.GuildText) return;
        const content = `**__Use Your Items Here!__**\n\n- **${getItemDisplay(TALK_PASS_NAME)}**: Unlocks the chat channel.\n- **${getItemDisplay(MLBB_PASS_NAME)}**: Logs usage for fun.`;
        const components = [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('use_talk_pass').setLabel(`Use 1 ${getItemDisplay(TALK_PASS_NAME)}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('use_mlbb_pass').setLabel(`Use 1 ${getItemDisplay(MLBB_PASS_NAME)}`).setStyle(ButtonStyle.Primary),
        )];
        const sentMessage = await channel.send({ content, components });
        useItemsMessageData = { messageId: sentMessage.id };
        await saveData();
    } catch (e) { console.error("Failed to post use items message:", e) }
}


async function setChatChannelPermissions(locked) {
    try {
        const chatChannel = await client.channels.fetch(CHAT_CHANNEL_ID);
        if (chatChannel && chatChannel.type === ChannelType.GuildText) {
            await chatChannel.permissionOverwrites.edit(chatChannel.guild.roles.everyone, { SendMessages: !locked });
            chatChannelState.isUnlocked = !locked;
            chatChannelState.unlockedDate = locked ? null : getTodayDate();
            if(locked) chatChannelState.unlockedBy = null;
            await saveData();
            console.log(`Chat channel permissions set to ${locked ? 'locked' : 'unlocked'}.`);
        }
    } catch (error) {
        console.error(`Error setting chat channel permissions:`, error);
    }
}

// --- Daily Reset & Cleanup ---
async function runAutomaticDailyReset() {
    console.log(`Running AUTOMATIC daily reset.`);
    const today = getTodayDate();
    const yesterday = getYesterdayDate();
    const twoDaysAgo = getTwoDaysAgoDate();

    // Apply penalties for tasks from two days ago
    for (const userId in userData) {
        const user = userData[userId];
        const completedMainTasks = (user.completed_tasks_by_date[twoDaysAgo] || []).filter(index => index < 5).length;
        const uncompletedCount = 5 - completedMainTasks;

        if (uncompletedCount > 0) {
            user.negative_shards = (user.negative_shards ?? 0) + uncompletedCount;
            let dmMessage = `⚠️ **Daily Task Penalty!** You missed ${uncompletedCount} main task(s) from **${twoDaysAgo}** and received ${uncompletedCount} ${getItemDisplay(NEGATIVE_SHARD_NAME)}.`;

            if (user.negative_shards >= 5) {
                const shardsToDeduct = Math.floor(user.negative_shards / 5);
                user.negative_shards %= 5;
                await removeItemsFromUser(userId, TALK_SHARD_NAME, shardsToDeduct);
                dmMessage += `\n🚨 Your ${getItemDisplay(NEGATIVE_SHARD_NAME)} count triggered a penalty! **${shardsToDeduct} ${getItemDisplay(TALK_SHARD_NAME)}** has been deducted.`;
            }
            dmMessage += `\nYour totals are now: ${countUserItem(userId, TALK_SHARD_NAME)} ${getItemDisplay(TALK_SHARD_NAME)} and ${user.negative_shards} ${getItemDisplay(NEGATIVE_SHARD_NAME)}.`;
            await sendDM(userId, dmMessage);
        }
    }

    // Relock chat if it was unlocked yesterday
    if (chatChannelState.isUnlocked && chatChannelState.unlockedDate === yesterday) {
        console.log(`Relocking chat channel due to daily reset.`);
        await setChatChannelPermissions(true);
    }

    // --- Clean up old messages and data ---
    const targetChannel = await client.channels.fetch(TARGET_CHANNEL_ID).catch(() => null);
    const shopChannel = await client.channels.fetch(SHOP_CHANNEL_ID).catch(() => null);
    const useItemsChannel = await client.channels.fetch(USE_ITEMS_CHANNEL_ID).catch(() => null);

    // Delete task list from 2 days ago
    if (dailyTasksMessageData[twoDaysAgo]) {
        await deleteMessageSafe(targetChannel, dailyTasksMessageData[twoDaysAgo].messageId, "2-day-old task message");
        await deleteMessageSafe(targetChannel, dailyTasksMessageData[twoDaysAgo].introMessageId, "2-day-old intro message");
        delete dailyTasksMessageData[twoDaysAgo];
    }
    // Delete shop message from yesterday
    if (publicShopMessageData[yesterday]) {
        await deleteMessageSafe(shopChannel, publicShopMessageData[yesterday].messageId, "yesterday's shop message");
        delete publicShopMessageData[yesterday];
    }
    // Delete old use-items message
    if (useItemsMessageData.messageId) {
        await deleteMessageSafe(useItemsChannel, useItemsMessageData.messageId, "old use-items message");
        useItemsMessageData = {};
    }

    // Clean user data
    for (const userId in userData) {
        delete userData[userId].completed_tasks_by_date[twoDaysAgo];
        delete userData[userId].daily_rewards_claimed[twoDaysAgo];
        Object.keys(userData[userId].pass_usage_by_date).forEach(passType => {
            if (userData[userId].pass_usage_by_date[passType] === twoDaysAgo) {
                delete userData[userId].pass_usage_by_date[passType];
            }
        });
    }
    await saveData();
    console.log(`Automatic daily data cleanup and penalty application complete.`);

    // --- Post Today's New Messages ---
    try {
        if (targetChannel) await sendDailyTaskList(targetChannel, 'A new day has begun! Here are today\'s tasks!');
        await postShopMessage();
        await postUseItemsMessage();
    } catch (error) {
        console.error(`FATAL: Could not send new daily messages after automatic reset.`, error);
    }
}

async function handleManualReset(commandChannel) {
    console.log('Handling manual reset command...');
    // Fetch all channels at once
    const channels = {};
    for (const { id, name } of [{ id: TARGET_CHANNEL_ID, name: 'main tasks' }, { id: SHOP_CHANNEL_ID, name: 'shop' }, { id: USE_ITEMS_CHANNEL_ID, name: 'use items' }]) {
        try {
            const channel = await client.channels.fetch(id);
            if (!channel || channel.type !== ChannelType.GuildText) throw new Error();
            channels[name.replace(' ', '')] = channel;
        } catch (error) {
            return commandChannel.send({ content: `❌ Error: The configured ${name} channel (<#${id}>) is invalid.`, ephemeral: true });
        }
    }

    if (chatChannelState.isUnlocked) await setChatChannelPermissions(true);

    // Delete messages for today and yesterday
    for (const date of [getTodayDate(), getYesterdayDate()]) {
        if (dailyTasksMessageData[date]) {
            await deleteMessageSafe(channels.maintasks, dailyTasksMessageData[date].messageId);
            await deleteMessageSafe(channels.maintasks, dailyTasksMessageData[date].introMessageId);
            delete dailyTasksMessageData[date];
        }
        if (publicShopMessageData[date]) {
            await deleteMessageSafe(channels.shop, publicShopMessageData[date].messageId);
            delete publicShopMessageData[date];
        }
    }
    await deleteMessageSafe(channels.useitems, useItemsMessageData.messageId);
    useItemsMessageData = {};

    // Clear user data for today and yesterday
    for (const userId in userData) {
        delete userData[userId].completed_tasks_by_date[getTodayDate()];
        delete userData[userId].daily_rewards_claimed[getTodayDate()];
        delete userData[userId].completed_tasks_by_date[getYesterdayDate()];
        delete userData[userId].daily_rewards_claimed[getYesterdayDate()];
    }
    await saveData();

    // Post fresh messages
    if (channels.maintasks) await sendDailyTaskList(channels.maintasks, "As requested, here is a fresh daily task list!");
    await postShopMessage();
    await postUseItemsMessage();

    await commandChannel.send({ content: `✅ Daily tasks and messages have been reset! Chat channel relocked.`, ephemeral: true });
}

// --- Bot Client Event Listeners ---
client.on("ready", async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    await loadData();

    // Schedule automatic reset for 12:00 PM (noon) PKT
    cron.schedule('0 7 * * *', runAutomaticDailyReset, { timezone: "Asia/Karachi" });
    console.log(`Automatic daily reset scheduled for 12:00 PM PKT (07:00 UTC).`);

    // On startup, ensure today's messages exist
    const today = getTodayDate();
    if (!dailyTasksMessageData[today]?.messageId || !publicShopMessageData[today]?.messageId || !useItemsMessageData.messageId) {
        console.log("One or more daily messages are missing on startup. Running a reset to generate them.");
        // We run a limited version of reset, without penalties
        await handleManualReset({ send: (msg) => console.log("Startup Reset:", msg.content) });
    }
});

client.on("messageCreate", async msg => {
    if (msg.author.bot || !msg.content.startsWith('!')) return;
    if (msg.channel.type !== ChannelType.GuildText) return;

    const args = msg.content.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const discordUserId = msg.author.id;

    try {
        if (cmd === "help") {
            const helpEmbed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🤖 Bot Features and Commands')
                .setDescription(`This bot helps track daily tasks, earn items, and use them for server features.`)
                .addFields(
                    { name: '📅 Daily Tasks & Rewards', value: `- A new task list appears daily in <#${TARGET_CHANNEL_ID}>.\n- Complete 5 main tasks for a ${getItemDisplay(MAIN_GROUP_REWARD_ITEM)}.\n- Complete the special task for an ${getItemDisplay(SPECIAL_TASK_REWARD_ITEM)}.\n- **Penalty**: Missed main tasks from 2 days ago result in ${getItemDisplay(NEGATIVE_SHARD_NAME)}. At 5 shards, 1 ${getItemDisplay(TALK_SHARD_NAME)} is deducted.` },
                    { name: '🛍️ Shop & Items', value: `- Visit <#${SHOP_CHANNEL_ID}> or use \`!shop\` to trade items.\n- **${getItemDisplay(TALK_PASS_NAME)}**: Unlocks chat. Trade 7x ${getItemDisplay(TALK_SHARD_NAME)} or 2x ${getItemDisplay(MLBB_PASS_NAME)}.\n- **${getItemDisplay(MLBB_PASS_NAME)}**: Fun pass. Trade 3x ${getItemDisplay(MLBB_SHARD_NAME)}.` },
                    { name: '🎟️ Item Usage', value: `- Go to <#${USE_ITEMS_CHANNEL_ID}> to use passes.\n- A ${getItemDisplay(TALK_PASS_NAME)} unlocks <#${CHAT_CHANNEL_ID}> for everyone until the next daily reset.` },
                    { name: '👤 User Commands', value: `\`!todo\` - View your personal task status.\n\`!myitems\` - See your inventory.\n\`!shop\` - Open your private shop menu.` },
                    { name: '👑 Admin Commands', value: `\`!resetdaily\` - Manually resets all daily messages and tasks.\n\`!resetall\` - **DANGEROUS!** Wipes all bot data.\n\`!adjustitem <give|take|set> @user "Item Name" <amount>\` - Modify a user's items.` }
                );
            const dismissRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dismiss_help').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
            await msg.reply({ embeds: [helpEmbed], components: [dismissRow], ephemeral: true });
        }
        else if (cmd === "todo") {
            const user = await getOrCreateUserData(discordUserId);
            let content = `**__Your Personal To-Do Status__**\n\n`;
            for (const date of [getTodayDate(), getYesterdayDate()]) {
                content += `**For ${date}:**\n`;
                const completed = user.completed_tasks_by_date[date] || [];
                FIXED_DAILY_TASKS.forEach((task, i) => {
                    content += `${completed.includes(i) ? '✅' : '⏳'} ${i + 1}. ${task}\n`;
                });
                content += '\n';
            }
            content += `**${getItemDisplay(NEGATIVE_SHARD_NAME)}:** ${user.negative_shards ?? 0}`;
            const dismissRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dismiss_todo').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
            await msg.reply({ content, components: [dismissRow], ephemeral: true });
        } 
        else if (cmd === "myitems") {
            await getOrCreateUserData(discordUserId);
            const responseContent = `**__${msg.author.username}'s Items__**\n\n`
                + `${getItemDisplayWithQuantity(TALK_SHARD_NAME, countUserItem(discordUserId, TALK_SHARD_NAME))}\n`
                + `${getItemDisplayWithQuantity(MLBB_SHARD_NAME, countUserItem(discordUserId, MLBB_SHARD_NAME))}\n`
                + `${getItemDisplayWithQuantity(TALK_PASS_NAME, countUserItem(discordUserId, TALK_PASS_NAME))}\n`
                + `${getItemDisplayWithQuantity(MLBB_PASS_NAME, countUserItem(discordUserId, MLBB_PASS_NAME))}\n`
                + `${getItemDisplayWithQuantity(NEGATIVE_SHARD_NAME, countUserItem(discordUserId, NEGATIVE_SHARD_NAME))}`;
            const dismissRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dismiss_myitems').setLabel('Dismiss').setStyle(ButtonStyle.Secondary));
            await msg.reply({ content: responseContent, components: [dismissRow], ephemeral: true });
        }
        else if (cmd === "shop") {
            const { content, components } = generateShopMessage(discordUserId);
            await msg.reply({ content, components, ephemeral: true });
        }
        else if (cmd === "resetdaily" && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await handleManualReset(msg.channel);
        }
        else if (cmd === "resetall" && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if(chatChannelState.isUnlocked) await setChatChannelPermissions(true);
            dailyTasksMessageData = {};
            publicShopMessageData = {};
            useItemsMessageData = {};
            userData = {};
            chatChannelState = { isUnlocked: false, unlockedBy: null, unlockedDate: null };
            await saveData();
            await msg.reply({ content: "🚨 All bot data has been permanently reset and chat channel relocked!", ephemeral: true });
            console.log("All data reset by admin.");
        }
        else if (cmd === "adjustitem" && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if (args.length < 3) return msg.reply({ content: `Usage: \`!adjustitem <give|take|set> @user "Item Name" <amount>\``, ephemeral: true });
            const action = args.shift().toLowerCase();
            const targetMember = msg.mentions.members.first() || await msg.guild.members.fetch(args.shift()).catch(() => null);
            if (!targetMember) return msg.reply({ content: `Could not find user.`, ephemeral: true });

            const remainingArgs = args.join(' ');
            const itemMatch = remainingArgs.match(/"([^"]+)"\s*(-?\d+)/);
            if (!itemMatch) return msg.reply({ content: 'Invalid format. Use `"Item Name" amount`', ephemeral: true });

            const [, itemName, amountStr] = itemMatch;
            const amount = parseInt(amountStr);

            if (!ALL_VALID_ITEMS.includes(itemName)) return msg.reply({ content: `Invalid item name: "${itemName}".`, ephemeral: true });
            if (isNaN(amount)) return msg.reply({ content: 'Amount must be a number.', ephemeral: true });

            let response = '';
            switch (action) {
                case 'give': await addItemToUser(targetMember.id, itemName, amount); response = `Gave ${amount} ${getItemDisplay(itemName)} to ${targetMember.displayName}.`; break;
                case 'take': await removeItemsFromUser(targetMember.id, itemName, amount); response = `Took ${amount} ${getItemDisplay(itemName)} from ${targetMember.displayName}.`; break;
                case 'set': await setItemsForUser(targetMember.id, itemName, amount); response = `Set ${targetMember.displayName}'s ${getItemDisplay(itemName)} to ${amount}.`; break;
                default: response = 'Invalid action. Use `give`, `take`, or `set`.';
            }
            await msg.reply({ content: `✅ ${response}`, ephemeral: true });
        }
    } catch (error) {
        console.error("Error handling command:", error);
        await msg.reply({ content: "An error occurred. Please try again.", ephemeral: true }).catch(() => {});
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    try {
        const userId = interaction.user.id;
        if (interaction.customId.startsWith('complete_task_')) {
            await interaction.deferUpdate();
            const [, , taskIndexStr, taskDate] = interaction.customId.split('_');
            const taskIndex = parseInt(taskIndexStr);
            const user = await getOrCreateUserData(userId);
            const completedTasks = user.completed_tasks_by_date[taskDate] || [];

            if (completedTasks.includes(taskIndex)) {
                return interaction.followUp({ content: `You already completed this task for ${taskDate}.`, ephemeral: true });
            }
            completedTasks.push(taskIndex);
            user.completed_tasks_by_date[taskDate] = completedTasks.sort((a, b) => a - b);

            let rewardMessage = `\n✅ Task marked as complete for ${taskDate}.`;
            if (taskDate === getTodayDate()) {
                const rewardsClaimedToday = user.daily_rewards_claimed[taskDate] || {};
                const allMainTasksDone = [0, 1, 2, 3, 4].every(i => completedTasks.includes(i));
                if (allMainTasksDone && !rewardsClaimedToday.mainGroup) {
                    await addItemToUser(userId, MAIN_GROUP_REWARD_ITEM);
                    rewardsClaimedToday.mainGroup = true;
                    rewardMessage += `\n🎉 Congrats! You completed all main tasks and got a **${getItemDisplay(MAIN_GROUP_REWARD_ITEM)}**!`;
                }
                if (completedTasks.includes(5) && !rewardsClaimedToday.specialTask) {
                    await addItemToUser(userId, SPECIAL_TASK_REWARD_ITEM);
                    rewardsClaimedToday.specialTask = true;
                    rewardMessage += `\n🎉 Congrats! You completed the special task and got a **${getItemDisplay(SPECIAL_TASK_REWARD_ITEM)}**!`;
                }
                user.daily_rewards_claimed[taskDate] = rewardsClaimedToday;
            }
            await saveData();

            const { content, components } = generateDailyTaskListMessage(taskDate, userData);
            await interaction.message.edit({ content, components });
            await interaction.followUp({ content: rewardMessage.trim(), ephemeral: true });
        } 
        else if (interaction.customId.startsWith('trade_')) {
            await interaction.deferUpdate();
            let feedback = '';
            const trades = {
                'trade_talk_shards_to_talk_pass': { cost: 7, from: TALK_SHARD_NAME, to: TALK_PASS_NAME },
                'trade_mlbb_shards_to_mlbb_pass': { cost: 3, from: MLBB_SHARD_NAME, to: MLBB_PASS_NAME },
                'trade_mlbb_pass_to_talk_pass': { cost: 2, from: MLBB_PASS_NAME, to: TALK_PASS_NAME },
            };
            const trade = trades[interaction.customId];
            if (trade && countUserItem(userId, trade.from) >= trade.cost) {
                await removeItemsFromUser(userId, trade.from, trade.cost);
                await addItemToUser(userId, trade.to, 1);
                feedback = `✅ Successfully traded for 1 ${getItemDisplay(trade.to)}!`;
            } else if (trade) {
                feedback = `❌ Insufficient items! You need ${trade.cost} ${getItemDisplay(trade.from)}.`;
            }

            const { content, components } = generateShopMessage(userId);
            await interaction.editReply({ content, components });
            if (feedback) await interaction.followUp({ content: feedback, ephemeral: true });
        }
        else if (interaction.customId === 'open_personal_shop') {
            const { content, components } = generateShopMessage(userId);
            await interaction.reply({ content, components, ephemeral: true });
        }
        else if (interaction.customId.startsWith('use_')) {
            const passType = interaction.customId === 'use_talk_pass' ? TALK_PASS_NAME : MLBB_PASS_NAME;
            const user = await getOrCreateUserData(userId);

            if (countUserItem(userId, passType) < 1) return interaction.reply({ content: `❌ You don't have any ${getItemDisplay(passType)}!`, ephemeral: true });

            const confirmRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`confirm_${interaction.customId}`).setLabel(`Yes, use 1 ${passType}`).setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('cancel_use').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            );
            await interaction.reply({ content: `Are you sure you want to use 1 ${getItemDisplay(passType)}?`, components: [confirmRow], ephemeral: true });
        }
        else if (interaction.customId.startsWith('confirm_use_')) {
            await interaction.deferUpdate();
            const passType = interaction.customId === 'confirm_use_talk_pass' ? TALK_PASS_NAME : MLBB_PASS_NAME;
            const user = await getOrCreateUserData(userId);

            if (user.pass_usage_by_date[passType] === getTodayDate()) {
                return interaction.editReply({ content: `❌ You have already used a ${getItemDisplay(passType)} today!`, components: [] });
            }
            if (passType === TALK_PASS_NAME && chatChannelState.isUnlocked) {
                 return interaction.editReply({ content: `❌ The chat channel is already unlocked by <@${chatChannelState.unlockedBy}>!`, components: [] });
            }

            if (await removeItemsFromUser(userId, passType, 1)) {
                user.pass_usage_by_date[passType] = getTodayDate();
                let announcement = `🎉 **${interaction.user.username}** has used 1 ${getItemDisplay(MLBB_PASS_NAME)}! GG!`;
                if (passType === TALK_PASS_NAME) {
                    await setChatChannelPermissions(false);
                    chatChannelState.unlockedBy = userId;
                    announcement = `📢 **${interaction.user.username}** has used 1 ${getItemDisplay(TALK_PASS_NAME)}! The chat channel (<#${CHAT_CHANNEL_ID}>) is now **UNLOCKED**!`;
                }
                await saveData();
                const announcementChannel = await client.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(() => null);
                if (announcementChannel) await announcementChannel.send(announcement);
                await interaction.editReply({ content: `✅ You have successfully used 1 ${getItemDisplay(passType)}!`, components: [] });
            } else {
                 await interaction.editReply({ content: `❌ You do not have enough ${getItemDisplay(passType)}.`, components: [] });
            }
        }
        else if (['dismiss_shop', 'dismiss_todo', 'dismiss_help', 'dismiss_myitems', 'cancel_use'].includes(interaction.customId)) {
            await interaction.message.delete().catch(() => {});
        }
    } catch (error) {
        console.error("Error handling interaction:", error);
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp({ content: 'There was an error!', ephemeral: true }).catch(() => {});
        } else {
            await interaction.reply({ content: 'There was an error!', ephemeral: true }).catch(() => {});
        }
    }
});

client.login(process.env.TOKEN);
