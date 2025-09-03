const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');

// Configuration
const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
    
    // List of specific usernames to monitor
    MONITORED_USERS: process.env.MONITORED_USERS ? 
        process.env.MONITORED_USERS.split(',').map(u => u.trim()) : 
        ['Username1', 'Username2'],
    
    // Group ID to monitor (replace with your group ID)
    GROUP_ID: process.env.GROUP_ID || '4594985',
    
    // Ranks to monitor (replace with actual rank numbers)
    MONITORED_RANKS: process.env.MONITORED_RANKS ? 
        process.env.MONITORED_RANKS.split(',').map(r => parseInt(r.trim())) : 
        [1, 2, 3], // Owner, Admin, Moderator
    
    // Notification settings
    NOTIFY_SPECIFIC_USERS: true,
    NOTIFY_GROUP_MEMBERS: true,
    NOTIFY_GROUP_RANKS: true,
    
    // NEW: Show rank info for ALL players in your group
    SHOW_GROUP_RANKS: true,
    
    // NEW: Ping everyone when someone joins
    PING_EVERYONE: true,
    
    // NEW: Check interval for user status
    CHECK_INTERVAL: process.env.CHECK_INTERVAL || 15, // seconds
    
    // NEW: Control offline notifications (default disabled)
    NOTIFY_ON_OFFLINE: typeof process.env.NOTIFY_ON_OFFLINE === 'string' 
        ? ['1','true','yes','y'].includes(process.env.NOTIFY_ON_OFFLINE.toLowerCase()) 
        : false,

    // Optional: Single-game focus
    TARGET_UNIVERSE_ID: process.env.TARGET_UNIVERSE_ID ? Number(process.env.TARGET_UNIVERSE_ID) : null,
    TARGET_PLACE_ID: process.env.TARGET_PLACE_ID ? Number(process.env.TARGET_PLACE_ID) : 5375160701,
    TARGET_GAME_NAME: process.env.TARGET_GAME_NAME || '🍍Work at Kecai Restaurant!'
};

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store user statuses
let userStatuses = new Map(); // username -> { isOnline: boolean, lastSeen: Date, currentGame: string | null, gameName: string | null, universeId?: number | null }
let isMonitoring = false;

// Roblox API functions
const usernameToIdCache = new Map();
const universeIdToGameName = new Map();
const placeIdToUniverseId = new Map();

// Discord embed field safety helper
function safeField(name, value, inline = true) {
    const safeName = String(name).slice(0, 256) || '\u200b';
    const safeValue = String(value).slice(0, 1024) || '\u200b';
    return { name: safeName, value: safeValue, inline };
}

// Fallback-capable HTTP helpers and base domains
const BASES = {
    users: [process.env.USERS_BASE || 'https://users.roproxy.com', 'https://users.roblox.com'],
    presence: [process.env.PRESENCE_BASE || 'https://presence.roproxy.com', 'https://presence.roblox.com'],
    groups: [process.env.GROUPS_BASE || 'https://groups.roproxy.com', 'https://groups.roblox.com'],
    games: [process.env.GAMES_BASE || 'https://games.roproxy.com', 'https://games.roblox.com'],
    apis: [process.env.APIS_BASE || 'https://apis.roproxy.com', 'https://apis.roblox.com']
};

async function getWithFallback(bases, path, config = {}) {
    let lastErr;
    for (const base of bases) {
        try {
            return await axios.get(`${base}${path}`, config);
        } catch (err) {
            lastErr = err;
            continue;
        }
    }
    throw lastErr;
}

async function postWithFallback(bases, path, data, config = {}) {
    let lastErr;
    for (const base of bases) {
        try {
            return await axios.post(`${base}${path}`, data, config);
        } catch (err) {
            lastErr = err;
            continue;
        }
    }
    throw lastErr;
}

async function getUserId(username) {
    if (usernameToIdCache.has(username)) return usernameToIdCache.get(username);
    const res = await postWithFallback(
        BASES.users,
        '/v1/usernames/users',
        { usernames: [username], excludeBannedUsers: true },
        { headers: { 'Content-Type': 'application/json' } }
    );
    const hit = res.data && res.data.data && res.data.data[0];
    if (!hit || !hit.id) throw new Error(`Username not found: ${username}`);
    usernameToIdCache.set(username, hit.id);
    return hit.id;
}

async function getUserStatus(username) {
    try {
        const userId = await getUserId(username);
        // Presence API requires POST with JSON body. Use roproxy (and fallback) to avoid auth.
        const statusResponse = await postWithFallback(
            BASES.presence,
            '/v1/presence/users',
            { userIds: [userId] },
            { headers: { 'Content-Type': 'application/json' } }
        );
        
        const presence = statusResponse.data && statusResponse.data.userPresences && statusResponse.data.userPresences[0];
        if (presence) {
            const presenceType = presence.userPresenceType ?? 0; // 0=Offline, 1=Online, 2=InGame, 3=InStudio
            const gameName = await resolveGameNameFromPresence(presence);
            return {
                isOnline: presenceType !== 0,
                currentGame: presence.placeId ? String(presence.placeId) : null,
                gameName: gameName,
                universeId: typeof presence.universeId === 'number' ? presence.universeId : (presence.universeId ? Number(presence.universeId) : null),
                lastSeen: presence.lastOnline ? new Date(presence.lastOnline) : new Date()
            };
        }
        
        return { isOnline: false, currentGame: null, lastSeen: new Date() };
    } catch (error) {
        const status = error.response && error.response.status;
        const data = error.response && error.response.data;
        console.error(`Error fetching status for ${username}:`, status, data || error.message);
        return { isOnline: false, currentGame: null, lastSeen: new Date() };
    }
}

async function getUserGroupInfo(username, groupId) {
    try {
        const userId = await getUserId(username);
        const groupResponse = await getWithFallback(BASES.groups, `/v1/users/${userId}/groups`);
        const userGroups = (groupResponse.data && groupResponse.data.data) || [];
        const targetGroup = userGroups.find(group => group.group && group.group.id === parseInt(groupId));
        return targetGroup ? { isInGroup: true, rank: targetGroup.role.rank, roleName: targetGroup.role.name } : { isInGroup: false, rank: 0, roleName: '' };
    } catch (error) {
        const status = error.response && error.response.status;
        const data = error.response && error.response.data;
        console.error('Error fetching user group info:', status, data || error.message);
        return { isInGroup: false, rank: 0, roleName: '' };
    }
}

// Resolve game name helpers
async function getGameNameByUniverseId(universeId) {
    if (!universeId) return null;
    if (universeIdToGameName.has(universeId)) return universeIdToGameName.get(universeId);
    try {
        const res = await getWithFallback(BASES.games, `/v1/games?universeIds=${universeId}`);
        const name = res.data && res.data.data && res.data.data[0] && res.data.data[0].name;
        if (name) {
            universeIdToGameName.set(universeId, name);
            return name;
        }
    } catch (err) {
        // Swallow and fallback
    }
    return null;
}

async function getUniverseIdByPlaceId(placeId) {
    if (!placeId) return null;
    if (placeIdToUniverseId.has(placeId)) return placeIdToUniverseId.get(placeId);
    try {
        const res = await getWithFallback(BASES.apis, `/universes/v1/places/${placeId}/universe`);
        const universeId = res.data && res.data.universeId;
        if (universeId) {
            placeIdToUniverseId.set(placeId, universeId);
            return universeId;
        }
    } catch (err) {
        // Swallow and fallback
    }
    return null;
}

async function resolveGameNameFromPresence(presence) {
    // Prefer explicit lastLocation if it looks like a game title
    if (presence && typeof presence.lastLocation === 'string' && presence.lastLocation.length > 0 && presence.lastLocation.toLowerCase() !== 'website') {
        // lastLocation sometimes already contains the place/game name
        return presence.lastLocation;
    }
    if (presence && presence.universeId) {
        if (CONFIG.TARGET_UNIVERSE_ID && Number(presence.universeId) === Number(CONFIG.TARGET_UNIVERSE_ID) && CONFIG.TARGET_GAME_NAME) {
            return CONFIG.TARGET_GAME_NAME;
        }
        return await getGameNameByUniverseId(presence.universeId);
    }
    if (presence && presence.placeId) {
        if (CONFIG.TARGET_PLACE_ID && Number(presence.placeId) === Number(CONFIG.TARGET_PLACE_ID) && CONFIG.TARGET_GAME_NAME) {
            return CONFIG.TARGET_GAME_NAME;
        }
        const universeId = await getUniverseIdByPlaceId(presence.placeId);
        if (universeId) return await getGameNameByUniverseId(universeId);
    }
    return null;
}

// Create notification embed
function createNotificationEmbed(username, type, rank = null, roleName = null, gameName = null) {
    const embed = new EmbedBuilder();
    
    if (type === 'user_online') {
        embed.setColor('#00FF00')
            .setTitle('🟢 User Online!')
            .setDescription(`${username} is now online on Roblox!`)
            .setTimestamp();
        
        if (gameName) {
            embed.addFields({ name: 'Current Game', value: gameName, inline: true });
        }
    } else if (type === 'user_offline') {
        embed.setColor('#FF0000')
            .setTitle('🔴 User Offline!')
            .setDescription(`${username} is now offline on Roblox!`)
            .setTimestamp();
    } else if (type === 'group_member_online') {
        embed.setColor('#00FF00')
            .setTitle('👥 Group Member Online!')
            .setDescription(`${username} (Rank: ${rank}) is now online!`)
            .setTimestamp();
        
        if (gameName) {
            embed.addFields({ name: 'Current Game', value: gameName, inline: true });
        }
    } else if (type === 'high_rank_online') {
        embed.setColor('#FFD700')
            .setTitle('⭐ High Rank Online!')
            .setDescription(`${username} (Rank ${rank}) is now online!`)
            .setTimestamp();
        
        if (gameName) {
            embed.addFields({ name: 'Current Game', value: gameName, inline: true });
        }
    }
    
    if (roleName) {
        embed.addFields({ name: 'Role', value: roleName, inline: true });
    }
    
    embed.setFooter({ text: 'Roblox User Monitor' });
    return embed;
}

// Send Discord notification
async function sendDiscordNotification(embed, pingEveryone = false) {
    try {
        const channel = await client.channels.fetch(CONFIG.DISCORD_CHANNEL_ID);
        
        // Create the message content
        let messageContent = '';
        if (pingEveryone && CONFIG.PING_EVERYONE) {
            messageContent = '@everyone'; // This pings everyone in the server
        }
        
        await channel.send({ 
            content: messageContent,
            embeds: [embed] 
        });
        console.log('Discord notification sent successfully');
    } catch (error) {
        console.error('Error sending Discord notification:', error.message);
    }
}

// Main monitoring function
async function checkUserStatuses() {
    if (!isMonitoring) return;
    
    try {
        console.log('Checking user statuses...');
        
        // Check monitored users (notify only when a user starts a new game or enters target game)
        for (const username of CONFIG.MONITORED_USERS) {
            const currentStatus = await getUserStatus(username);
            const previousStatus = userStatuses.get(username);

            // Decide if we should notify: either starting any new game, or specifically entering target game if configured
            let startedNewGame = (
                currentStatus.isOnline &&
                !!currentStatus.currentGame &&
                (!previousStatus || previousStatus.currentGame !== currentStatus.currentGame)
            );

            if (CONFIG.TARGET_UNIVERSE_ID || CONFIG.TARGET_PLACE_ID) {
                const isInTargetNow = (
                    (CONFIG.TARGET_PLACE_ID && Number(currentStatus.currentGame) === Number(CONFIG.TARGET_PLACE_ID)) ||
                    (CONFIG.TARGET_UNIVERSE_ID && currentStatus.universeId && Number(currentStatus.universeId) === Number(CONFIG.TARGET_UNIVERSE_ID))
                );
                const wasInTargetBefore = previousStatus && (
                    (CONFIG.TARGET_PLACE_ID && Number(previousStatus.currentGame) === Number(CONFIG.TARGET_PLACE_ID)) ||
                    (CONFIG.TARGET_UNIVERSE_ID && previousStatus.universeId && Number(previousStatus.universeId) === Number(CONFIG.TARGET_UNIVERSE_ID))
                );
                // Only notify when entering target from not-in-target
                startedNewGame = isInTargetNow && !wasInTargetBefore;
            }
            const justWentOffline = !currentStatus.isOnline && previousStatus && previousStatus.isOnline;

            if (startedNewGame) {
                console.log(`🔔 ${username} started a new game: ${currentStatus.gameName || currentStatus.currentGame}`);
                // Optionally include group/rank in the first online ping
                let groupRank = null;
                let roleName = null;
                try {
                    if (CONFIG.NOTIFY_GROUP_MEMBERS || CONFIG.NOTIFY_GROUP_RANKS) {
                        const groupInfo = await getUserGroupInfo(username, CONFIG.GROUP_ID);
                        if (groupInfo.isInGroup) {
                            groupRank = groupInfo.rank;
                            roleName = groupInfo.roleName;
                        }
                    }
                } catch {}

                // High-rank special formatting if enabled
                if (groupRank !== null && CONFIG.NOTIFY_GROUP_RANKS && CONFIG.MONITORED_RANKS.includes(groupRank)) {
                    const embed = createNotificationEmbed(username, 'high_rank_online', groupRank, roleName, currentStatus.gameName || currentStatus.currentGame);
                    await sendDiscordNotification(embed, true);
                } else if (groupRank !== null && CONFIG.NOTIFY_GROUP_MEMBERS) {
                    const embed = createNotificationEmbed(username, 'group_member_online', groupRank, roleName, currentStatus.gameName || currentStatus.currentGame);
                    await sendDiscordNotification(embed, true);
                } else {
                    const embed = createNotificationEmbed(username, 'user_online', null, null, currentStatus.gameName || currentStatus.currentGame);
                    await sendDiscordNotification(embed, true);
                }
            }

            if (justWentOffline && CONFIG.NOTIFY_ON_OFFLINE) {
                console.log(`🔕 ${username} went offline (notification enabled).`);
                const embed = createNotificationEmbed(username, 'user_offline');
                await sendDiscordNotification(embed, false);
            }

            // Update status
            userStatuses.set(username, currentStatus);
        }
        
        // Update bot status
        const onlineUsers = Array.from(userStatuses.values()).filter(status => status.isOnline).length;
        client.user.setActivity(`Monitoring ${onlineUsers} users online`, { type: 3 });
        
    } catch (error) {
        console.error('Error checking user statuses:', error.message);
    }
}

// Discord bot events
client.once('ready', () => {
    console.log(`�� Discord bot logged in as ${client.user.tag}`);
    console.log(`👥 Monitored users: ${CONFIG.MONITORED_USERS.join(', ')}`);
    console.log(`🏢 Monitoring group ID: ${CONFIG.GROUP_ID}`);
    console.log(`⭐ Monitored ranks: ${CONFIG.MONITORED_RANKS.join(', ')}`);
    console.log(`ℹ️ Showing rank info for all group members: ${CONFIG.SHOW_GROUP_RANKS}`);
    console.log(`🔔 Pinging everyone on join: ${CONFIG.PING_EVERYONE}`);
    
    // Set bot status
    client.user.setActivity('Setting up monitoring...', { type: 3 });
    
    // Start monitoring
    isMonitoring = true;
    checkUserStatuses();
    
    // Schedule regular checks
    setInterval(checkUserStatuses, CONFIG.CHECK_INTERVAL * 1000);
    
    console.log('✅ Monitoring started successfully!');
});

// Bot commands
client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;
    
    // Check if message starts with our prefix
    const prefix = '!';
    if (!message.content.startsWith(prefix)) return;
    
    console.log(`Command received: ${message.content}`); // Debug log
    
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    console.log(`Command: ${command}, Args: ${args}`); // Debug log
    
    try {
        switch (command) {
            case 'status':
                const onlineUsers = Array.from(userStatuses.values()).filter(status => status.isOnline);
                const statusEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('📊 Monitor Status')
                    .addFields(
                        { name: 'Monitoring', value: isMonitoring ? '✅ Active' : '❌ Inactive', inline: true },
                        { name: 'Online Users', value: onlineUsers.length.toString(), inline: true },
                        { name: 'Total Monitored', value: CONFIG.MONITORED_USERS.length.toString(), inline: true },
                        { name: 'Monitored Users', value: CONFIG.MONITORED_USERS.join(', ') || 'None', inline: false },
                        { name: 'Group ID', value: CONFIG.GROUP_ID, inline: true },
                        { name: 'Check Interval', value: `${CONFIG.CHECK_INTERVAL}s`, inline: true },
                        { name: 'Show Group Ranks', value: CONFIG.SHOW_GROUP_RANKS ? '✅ Yes' : '❌ No', inline: true },
                        { name: 'Ping Everyone', value: CONFIG.PING_EVERYONE ? '✅ Yes' : '❌ No', inline: true },
                        { name: 'Notify On Offline', value: CONFIG.NOTIFY_ON_OFFLINE ? '✅ Yes' : '❌ No', inline: true }\n                    )\n                    .setTimestamp();\n                \n                await message.reply({ embeds: [statusEmbed] });\n                console.log('Status command executed successfully'); // Debug log\n                break;\n                \ncase 'users':\n    try {\n        const fields = [];\n        for (const username of CONFIG.MONITORED_USERS) {\n            const status = userStatuses.get(username);\n            const isOnline = !!(status && status.isOnline);\n            const statusText = isOnline ? '🟢 Online' : '🔴 Offline';\n            const gameTitle = status && (status.gameName || status.currentGame) ? (status.gameName || status.currentGame) : null;\n            const gameLabel = isOnline && gameTitle ? ` (Game: ${gameTitle})` : '';\n            fields.push(safeField(username, statusText + gameLabel, true));\n        }\n\n        if (fields.length === 0) {\n            await message.reply('No monitored users configured.');\n            break;\n        }\n\n        // Discord limit: 25 fields per embed\n        const chunks = [];\n        for (let i = 0; i < fields.length; i += 25) {\n            chunks.push(fields.slice(i, i + 25));\n        }\n\n        for (let index = 0; index < chunks.length; index++) {\n            try {\n                const embed = new EmbedBuilder()\n                    .setColor('#00ff00')\n                    .setTitle('👥 User Status')\n                    .setDescription('Current status of monitored users:')\n                    .addFields(chunks[index])\n                    .setTimestamp();\n                if (index === 0) {\n                    await message.reply({ embeds: [embed] });\n                } else {\n                    await message.channel.send({ embeds: [embed] });\n                }\n            } catch (sendErr) {\n                console.error('Error sending users embed chunk:', sendErr);\n            }\n        }\n        console.log('Users command executed successfully');\n    } catch (error) {\n        console.error('Error in users command:', error);\n        await message.reply('❌ Error showing user statuses. Try again later.');\n    }\n    break;\n\ncase 'games':\n    try {\n        // Build list of online users with their games\n        const onlineEntries = [];\n        for (const username of CONFIG.MONITORED_USERS) {\n            const status = userStatuses.get(username);\n            if (status && status.isOnline) {\n                const gameTitle = status.gameName || status.currentGame || 'Unknown game';\n                onlineEntries.push(safeField(username, gameTitle, true));\n            }\n        }\n\n        if (onlineEntries.length === 0) {\n            await message.reply('No monitored users are online right now.');\n            break;\n        }\n\n        // Chunk into 25 fields per embed\n        const chunks = [];\n        for (let i = 0; i < onlineEntries.length; i += 25) {\n            chunks.push(onlineEntries.slice(i, i + 25));\n        }\n\n        for (let index = 0; index < chunks.length; index++) {\n            try {\n                const embed = new EmbedBuilder()\n                    .setColor('#5865F2')\n                    .setTitle('🎮 Online Users and Games')\n                    .setDescription('Users currently in games:')\n                    .addFields(chunks[index])\n                    .setTimestamp();\n                if (index === 0) {\n                    await message.reply({ embeds: [embed] });\n                } else {\n                    await message.channel.send({ embeds: [embed] });\n                }\n            } catch (sendErr) {\n                console.error('Error sending games embed chunk:', sendErr);\n            }\n        }\n        console.log('Games command executed successfully');\n    } catch (error) {\n        console.error('Error in games command:', error);\n        await message.reply('❌ Error showing games. Try again later.');\n    }\n    break;\n                \n            case 'start':\n                if (!isMonitoring) {\n                    isMonitoring = true;\n                    checkUserStatuses();\n                    await message.reply('✅ Monitoring started!');\n                } else {\n                    await message.reply('⚠️ Monitoring is already active!');\n                }\n                break;\n                \n            case 'stop':\n                if (isMonitoring) {\n                    isMonitoring = false;\n                    await message.reply('⏹️ Monitoring stopped!');\n                } else {\n                    await message.reply('⚠️ Monitoring is already stopped!');\n                }\n                break;\n                \n            case 'help':\n                const helpEmbed = new EmbedBuilder()\n                    .setColor('#0099ff')\n                    .setTitle('🤖 Bot Commands')\n                    .addFields(\n                        { name: '!help', value: 'Show this help message', inline: false },\n                        { name: '!status', value: 'Show current monitor status', inline: false },\n                        { name: '!users', value: 'Show current user statuses', inline: false },\n                        { name: '!games', value: 'Show online users and their games', inline: false },\n                        { name: '!start', value: 'Start monitoring', inline: false },\n                        { name: '!stop', value: 'Stop monitoring', inline: false }\n                    )\n                    .setTimestamp();\n                \n                await message.reply({ embeds: [helpEmbed] });\n                console.log('Help command executed successfully'); // Debug log\n                break;\n                \n            default:\n                console.log(`Unknown command: ${command}`); // Debug log\n                break;\n        }\n    } catch (error) {\n        console.error(`Error executing command ${command}:`, error);\n        await message.reply('❌ An error occurred while executing the command.');\n    }\n});\n\n// Error handling\nclient.on('error', (error) => {\n    console.error('Discord client error:', error);\n});\n\nprocess.on('unhandledRejection', (error) => {\n    console.error('Unhandled promise rejection:', error);\n});\n\n// Login to Discord\nif (!CONFIG.DISCORD_TOKEN) {\n    console.error('❌ DISCORD_TOKEN is required in .env file!');\n    process.exit(1);\n}\n\nif (!CONFIG.DISCORD_CHANNEL_ID) {\n    console.error('❌ DISCORD_CHANNEL_ID is required in .env file!');\n    process.exit(1);\n}\n\nclient.login(CONFIG.DISCORD_TOKEN);\n```
