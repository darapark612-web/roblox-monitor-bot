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
        : false
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
let userStatuses = new Map(); // username -> { isOnline: boolean, lastSeen: Date, currentGame: string | null, gameName: string | null }
let isMonitoring = false;

// Roblox API functions
const usernameToIdCache = new Map();
const universeIdToGameName = new Map();
const placeIdToUniverseId = new Map();

async function getUserId(username) {
    if (usernameToIdCache.has(username)) return usernameToIdCache.get(username);
    const res = await axios.post(
        'https://users.roproxy.com/v1/usernames/users',
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
        const statusResponse = await axios.post(
            'https://presence.roproxy.com/v1/presence/users',
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
        const groupResponse = await axios.get(`https://groups.roproxy.com/v1/users/${userId}/groups`);
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
        const res = await axios.get(`https://games.roproxy.com/v1/games?universeIds=${universeId}`);
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
        const res = await axios.get(`https://apis.roproxy.com/universes/v1/places/${placeId}/universe`);
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
        return await getGameNameByUniverseId(presence.universeId);
    }
    if (presence && presence.placeId) {
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
        
        // Check monitored users (notify only when a user starts a new game)
        for (const username of CONFIG.MONITORED_USERS) {
            const currentStatus = await getUserStatus(username);
            const previousStatus = userStatuses.get(username);

            const startedNewGame = (
                currentStatus.isOnline &&
                !!currentStatus.currentGame &&
                (!previousStatus || previousStatus.currentGame !== currentStatus.currentGame)
            );
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
                        { name: 'Notify On Offline', value: CONFIG.NOTIFY_ON_OFFLINE ? '✅ Yes' : '❌ No', inline: true }
                    )
                    .setTimestamp();
                
                await message.reply({ embeds: [statusEmbed] });
                console.log('Status command executed successfully'); // Debug log
                break;
                
case 'users':
    try {
        const usersEmbed = new EmbedBuilder()
            .setColor('#00ff00')
            .setTitle('👥 User Status')
            .setDescription('Current status of monitored users:');
        
        for (const username of CONFIG.MONITORED_USERS) {
            const status = userStatuses.get(username);
            const statusText = status && status.isOnline ? '🟢 Online' : '🔴 Offline';
            const gameTitle = status && (status.gameName || status.currentGame) ? (status.gameName || status.currentGame) : null;
            const gameLabel = gameTitle ? ` (Game: ${gameTitle})` : '';
            usersEmbed.addFields({ name: username, value: statusText + gameLabel, inline: true });
        }
        
        usersEmbed.setTimestamp();
        await message.reply({ embeds: [usersEmbed] });
        console.log('Users command executed successfully');
    } catch (error) {
        console.error('Error in users command:', error);
        await message.reply('❌ Error showing user statuses. Try again later.');
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
                        { name: '!start', value: 'Start monitoring', inline: false },
                        { name: '!stop', value: 'Stop monitoring', inline: false }
                    )
                    .setTimestamp();
                
                await message.reply({ embeds: [helpEmbed] });
                console.log('Help command executed successfully'); // Debug log
                break;
                
            default:
                console.log(`Unknown command: ${command}`); // Debug log
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
