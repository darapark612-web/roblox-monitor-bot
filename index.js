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

// Force roproxy-only (no fallback to roblox.com) unless explicitly disabled
const NO_ROBLOX_FALLBACK = typeof process.env.NO_ROBLOX_FALLBACK === 'string'
    ? ['1','true','yes','y'].includes(process.env.NO_ROBLOX_FALLBACK.toLowerCase())
    : true;

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store user statuses
let userStatuses = new Map(); // username -> { isOnline: boolean, isInGame: boolean, lastSeen: Date, currentGame: string | null, gameName: string | null, universeId?: number | null }
let isMonitoring = false;
let isCheckingStatuses = false; // prevent overlapping checks
const lastLeftNotifiedPlaceId = new Map(); // username -> last placeId left that we notified

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
function bases(primary, secondary) {
    return NO_ROBLOX_FALLBACK ? [primary] : [primary, secondary];
}

const BASES = {
    users: bases(process.env.USERS_BASE || 'https://users.roproxy.com', 'https://users.roblox.com'),
    presence: bases(process.env.PRESENCE_BASE || 'https://presence.roproxy.com', 'https://presence.roblox.com'),
    groups: bases(process.env.GROUPS_BASE || 'https://groups.roproxy.com', 'https://groups.roblox.com'),
    games: bases(process.env.GAMES_BASE || 'https://games.roproxy.com', 'https://games.roblox.com'),
    apis: bases(process.env.APIS_BASE || 'https://apis.roproxy.com', 'https://apis.roblox.com')
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
        // Presence API requires POST with JSON body. Use roproxy to avoid auth.
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
                isInGame: presenceType === 2,
                currentGame: presence.placeId ? String(presence.placeId) : null,
                gameName: gameName,
                universeId: typeof presence.universeId === 'number' ? presence.universeId : (presence.universeId ? Number(presence.universeId) : null),
                lastSeen: presence.lastOnline ? new Date(presence.lastOnline) : new Date()
            };
        }
        
        return { isOnline: false, isInGame: false, currentGame: null, gameName: null, lastSeen: new Date() };
    } catch (error) {
        const status = error.response && error.response.status;
        const data = error.response && error.response.data;
        console.error(`Error fetching status for ${username}:`, status, data || error.message);
        return { isOnline: false, isInGame: false, currentGame: null, gameName: null, lastSeen: new Date() };
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
    } catch (err) {}
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
    } catch (err) {}
    return null;
}

async function resolveGameNameFromPresence(presence) {
    if (presence && typeof presence.lastLocation === 'string' && presence.lastLocation.length > 0 && presence.lastLocation.toLowerCase() !== 'website') {
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
    } else if (type === 'user_left_game') {
        embed.setColor('#FFA500')
            .setTitle('⏹️ User Left Game')
            .setDescription(`${username} left the game`)
            .setTimestamp();
        if (gameName) {
            embed.addFields({ name: 'Game', value: gameName, inline: true });
        }
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
        
        let messageContent = '';
        if (pingEveryone && CONFIG.PING_EVERYONE) {
            messageContent = '@everyone';
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
    if (isCheckingStatuses) return; // skip if previous tick still running
    isCheckingStatuses = true;
    
    try {
        console.log('Checking user statuses...');
        
        for (const username of CONFIG.MONITORED_USERS) {
            const currentStatus = await getUserStatus(username);
            const previousStatus = userStatuses.get(username);

            // Join ping: when user becomes in-game for the first time or switches games
            const startedNewGame = (
                currentStatus.isInGame &&
                !!currentStatus.currentGame &&
                (!previousStatus || !previousStatus.isInGame || previousStatus.currentGame !== currentStatus.currentGame)
            );
            const justWentOffline = !currentStatus.isOnline && previousStatus && previousStatus.isOnline;

            if (startedNewGame) {
                console.log(`🔔 ${username} started a new game: ${currentStatus.gameName || currentStatus.currentGame}`);
                const embed = createNotificationEmbed(username, 'user_online', null, null, currentStatus.gameName || currentStatus.currentGame);
                await sendDiscordNotification(embed, true);
            }

            // Leave game message (no ping) - only once per placeId left
            const leftGame = (
                previousStatus && previousStatus.isInGame && (
                    !currentStatus.isInGame || !currentStatus.currentGame
                )
            );
            if (leftGame) {
                const cacheKey = username;
                const lastNotifiedPlace = lastLeftNotifiedPlaceId.get(cacheKey);
                const justLeftPlace = previousStatus.currentGame || null;
                if (justLeftPlace && lastNotifiedPlace !== justLeftPlace) {
                    const embed = createNotificationEmbed(username, 'user_left_game', null, null, previousStatus.gameName || previousStatus.currentGame);
                    await sendDiscordNotification(embed, false);
                    lastLeftNotifiedPlaceId.set(cacheKey, justLeftPlace);
                }
            }

            userStatuses.set(username, currentStatus);
            // Clear left-game cache when they're currently in a game so that next leave will notify once
            if (currentStatus && currentStatus.isInGame) {
                lastLeftNotifiedPlaceId.delete(username);
            }
        }
        
        const onlineUsers = Array.from(userStatuses.values()).filter(status => status.isOnline).length;
        client.user.setActivity(`Monitoring ${onlineUsers} users online`, { type: 3 });
        
    } catch (error) {
        console.error('Error checking user statuses:', error.message);
    } finally {
        isCheckingStatuses = false;
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
    
    client.user.setActivity('Setting up monitoring...', { type: 3 });
    
    isMonitoring = true;
    checkUserStatuses();
    
    setInterval(checkUserStatuses, CONFIG.CHECK_INTERVAL * 1000);
    
    console.log('✅ Monitoring started successfully!');
});

// Bot commands
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    const prefix = '!';
    if (!message.content.startsWith(prefix)) return;
    
    console.log(`Command received: ${message.content}`);
    
    const args = message.content.slice(prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    
    console.log(`Command: ${command}, Args: ${args}`);
    
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
                        { name: 'Notify On Offline', value: CONFIG.NOTIFY_ON_OFFLINE ? '✅ Yes' : '❌ No', inline: true }
                    )
                    .setTimestamp();
                
                await message.reply({ embeds: [statusEmbed] });
                console.log('Status command executed successfully');
                break;
                
case 'users':
    try {
        const fields = [];
        for (const username of CONFIG.MONITORED_USERS) {
            const status = userStatuses.get(username);
            const isOnline = !!(status && status.isOnline);
            const statusText = isOnline ? '🟢 Online' : '🔴 Offline';
            const gameTitle = status && (status.gameName || status.currentGame) ? (status.gameName || status.currentGame) : null;
            const gameLabel = status && status.isInGame && gameTitle ? ` (Game: ${gameTitle})` : '';
            fields.push(safeField(username, statusText + gameLabel, true));
        }

        if (fields.length === 0) {
            await message.reply('No monitored users configured.');
            break;
        }

        const chunks = [];
        for (let i = 0; i < fields.length; i += 25) {
            chunks.push(fields.slice(i, i + 25));
        }

        for (let index = 0; index < chunks.length; index++) {
            try {
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('👥 User Status')
                    .setDescription('Current status of monitored users:')
                    .addFields(chunks[index])
                    .setTimestamp();
                if (index === 0) {
                    await message.reply({ embeds: [embed] });
                } else {
                    await message.channel.send({ embeds: [embed] });
                }
            } catch (sendErr) {
                console.error('Error sending users embed chunk:', sendErr);
            }
        }
        console.log('Users command executed successfully');
    } catch (error) {
        console.error('Error in users command:', error);
        await message.reply('❌ Error showing user statuses. Try again later.');
    }
    break;

case 'games':
    try {
        const onlineEntries = [];
        for (const username of CONFIG.MONITORED_USERS) {
            const status = userStatuses.get(username);
            if (status && status.isInGame) {
                const gameTitle = status.gameName || status.currentGame || 'Unknown game';
                onlineEntries.push(safeField(username, gameTitle, true));
            }
        }

        if (onlineEntries.length === 0) {
            await message.reply('No monitored users are in a game right now.');
            break;
        }

        const chunks = [];
        for (let i = 0; i < onlineEntries.length; i += 25) {
            chunks.push(onlineEntries.slice(i, i + 25));
        }

        for (let index = 0; index < chunks.length; index++) {
            try {
                const embed = new EmbedBuilder()
                    .setColor('#5865F2')
                    .setTitle('🎮 Online Users and Games')
                    .setDescription('Users currently in games:')
                    .addFields(chunks[index])
                    .setTimestamp();
                if (index === 0) {
                    await message.reply({ embeds: [embed] });
                } else {
                    await message.channel.send({ embeds: [embed] });
                }
            } catch (sendErr) {
                console.error('Error sending games embed chunk:', sendErr);
            }
        }
        console.log('Games command executed successfully');
    } catch (error) {
        console.error('Error in games command:', error);
        await message.reply('❌ Error showing games. Try again later.');
    }
    break;
                
            case 'start':
                if (!isMonitoring) {
                    isMonitoring = true;
                    checkUserStatuses();
                    await message.reply('✅ Monitoring started!');
                } else {
                    await message.reply('⚠️ Monitoring is already active!');
                }
                break;
                
            case 'stop':
                if (isMonitoring) {
                    isMonitoring = false;
                    await message.reply('⏹️ Monitoring stopped!');
                } else {
                    await message.reply('⚠️ Monitoring is already stopped!');
                }
                break;
                
            case 'help':
                const helpEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('🤖 Bot Commands')
                    .addFields(
                        { name: '!help', value: 'Show this help message', inline: false },
                        { name: '!status', value: 'Show current monitor status', inline: false },
                        { name: '!users', value: 'Show current user statuses', inline: false },
                        { name: '!games', value: 'Show online users and their games', inline: false },
                        { name: '!start', value: 'Start monitoring', inline: false },
                        { name: '!stop', value: 'Stop monitoring', inline: false }
                    )
                    .setTimestamp();
                
                await message.reply({ embeds: [helpEmbed] });
                console.log('Help command executed successfully');
                break;
                
            default:
                console.log(`Unknown command: ${command}`);
                break;
        }
    } catch (error) {
        console.error(`Error executing command ${command}:`, error);
        await message.reply('❌ An error occurred while executing the command.');
    }
});

// Error handling
client.on('error', (error) => {
    console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Login to Discord
if (!CONFIG.DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN is required in .env file!');
    process.exit(1);
}

if (!CONFIG.DISCORD_CHANNEL_ID) {
    console.error('❌ DISCORD_CHANNEL_ID is required in .env file!');
    process.exit(1);
}

client.login(CONFIG.DISCORD_TOKEN);
