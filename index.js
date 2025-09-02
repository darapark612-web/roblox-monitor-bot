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
    CHECK_INTERVAL: process.env.CHECK_INTERVAL || 30 // seconds
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
let userStatuses = new Map(); // username -> { isOnline: boolean, lastSeen: Date, currentGame: string }
let isMonitoring = false;

// Roblox API functions
async function getUserStatus(username) {
    try {
        // Get user ID first
        const userResponse = await axios.get(`https://api.roblox.com/users/get-by-username?username=${username}`);
        const userId = userResponse.data.Id;
        
        // Get user's current status
        const statusResponse = await axios.get(`https://presence.roblox.com/v1/presence/users`, {
            data: { userIds: [userId] }
        });
        
        if (statusResponse.data.userPresences && statusResponse.data.userPresences[0]) {
            const presence = statusResponse.data.userPresences[0];
            return {
                isOnline: presence.userPresenceType === 2, // 2 = Online
                currentGame: presence.placeId ? presence.placeId.toString() : null,
                lastSeen: new Date(presence.lastOnline)
            };
        }
        
        return { isOnline: false, currentGame: null, lastSeen: new Date() };
    } catch (error) {
        console.error(`Error fetching status for ${username}:`, error.message);
        return { isOnline: false, currentGame: null, lastSeen: new Date() };
    }
}

async function getUserGroupInfo(username, groupId) {
    try {
        // First get user ID
        const userResponse = await axios.get(`https://api.roblox.com/users/get-by-username?username=${username}`);
        const userId = userResponse.data.Id;
        
        // Then get group info
        const groupResponse = await axios.get(`https://groups.roblox.com/v1/users/${userId}/groups`);
        const userGroups = groupResponse.data.data;
        
        const targetGroup = userGroups.find(group => group.group.id === parseInt(groupId));
        return targetGroup ? { isInGroup: true, rank: targetGroup.role.rank, roleName: targetGroup.role.name } : { isInGroup: false, rank: 0, roleName: '' };
    } catch (error) {
        console.error('Error fetching user group info:', error.message);
        return { isInGroup: false, rank: 0, roleName: '' };
    }
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
        
        // Check monitored users
        for (const username of CONFIG.MONITORED_USERS) {
            const currentStatus = await getUserStatus(username);
            const previousStatus = userStatuses.get(username);
            
            // User came online
            if (currentStatus.isOnline && (!previousStatus || !previousStatus.isOnline)) {
                console.log(`🔔 ${username} came online!`);
                
                const embed = createNotificationEmbed(username, 'user_online', null, null, currentStatus.currentGame);
                await sendDiscordNotification(embed, true);
            }
            
            // User went offline
            if (!currentStatus.isOnline && previousStatus && previousStatus.isOnline) {
                console.log(`🔔 ${username} went offline!`);
                
                const embed = createNotificationEmbed(username, 'user_offline');
                await sendDiscordNotification(embed, false);
            }
            
            // Update status
            userStatuses.set(username, currentStatus);
        }
        
        // Check group members
        for (const username of CONFIG.MONITORED_USERS) {
            const groupInfo = await getUserGroupInfo(username, CONFIG.GROUP_ID);
            if (groupInfo.isInGroup) {
                const currentStatus = userStatuses.get(username);
                
                if (currentStatus && currentStatus.isOnline) {
                    // Group member is online
                    if (CONFIG.NOTIFY_GROUP_RANKS && CONFIG.MONITORED_RANKS.includes(groupInfo.rank)) {
                        // High rank member
                        const embed = createNotificationEmbed(username, 'high_rank_online', groupInfo.rank, groupInfo.roleName, currentStatus.currentGame);
                        await sendDiscordNotification(embed, true);
                    } else {
                        // Regular group member
                        const embed = createNotificationEmbed(username, 'group_member_online', groupInfo.rank, groupInfo.roleName, currentStatus.currentGame);
                        await sendDiscordNotification(embed, true);
                    }
                }
            }
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
                        { name: 'Ping Everyone', value: CONFIG.PING_EVERYONE ? '✅ Yes' : '❌ No', inline: true }
                    )
                    .setTimestamp();
                
                await message.reply({ embeds: [statusEmbed] });
                console.log('Status command executed successfully'); // Debug log
                break;
                
            case 'users':
                const usersEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('👥 User Status')
                    .setDescription('Current status of monitored users:');
                
                for (const username of CONFIG.MONITORED_USERS) {
                    const status = userStatuses.get(username);
                    const statusText = status && status.isOnline ? '🟢 Online' : '🔴 Offline';
                    const gameText = status && status.currentGame ? ` (Game: ${status.currentGame})` : '';
                    usersEmbed.addFields({ name: username, value: statusText + gameText, inline: true });
                }
                
                usersEmbed.setTimestamp();
                await message.reply({ embeds: [usersEmbed] });
                console.log('Users command executed successfully'); // Debug log
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
client.login(CONFIG.DISCORD_TOKEN);
