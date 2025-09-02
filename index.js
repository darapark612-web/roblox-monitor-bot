const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

// Configuration
const CONFIG = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN,
    DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
    ROBLOX_GAME_ID: process.env.ROBLOX_GAME_ID || '5375160701',
    CHECK_INTERVAL: process.env.CHECK_INTERVAL || 30, // seconds

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
    PING_EVERYONE: true
};

// Create Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Store current players
let currentPlayers = new Set();
let isMonitoring = false;

// Roblox API functions
async function getGamePlayers(gameId) {
    try {
        // Try multiple API endpoints
        const endpoints = [
            `https://games.roblox.com/v1/games/${gameId}/servers/0/players`,
            `https://games.roblox.com/v1/games/${gameId}/servers`,
            `https://games.roblox.com/v1/games/${gameId}/status`
        ];
        
        for (const endpoint of endpoints) {
            try {
                const response = await axios.get(endpoint);
                if (response.data && response.data.data) {
                    return response.data.data;
                }
            } catch (e) {
                console.log(`Trying endpoint: ${endpoint} - Failed`);
                continue;
            }
        }
        
        // If all endpoints fail, try a different approach
        console.log('All standard endpoints failed, trying alternative method...');
        return [];
        
    } catch (error) {
        console.error('Error fetching game players:', error.message);
        return [];
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
function createNotificationEmbed(username, type, rank = null, roleName = null, groupName = null) {
    const embed = new EmbedBuilder();

    if (type === 'specific_user') {
        embed.setColor('#FF0000')
            .setTitle('🚨 Specific User Alert!')
            .setDescription(`${username} has joined the game!`)
            .setTimestamp();
    } else if (type === 'group_member') {
        embed.setColor('#00FF00')
            .setTitle('👥 Group Member Joined!')
            .setDescription(`${username} (Rank: ${rank}) has joined the game!`)
            .setTimestamp();
    } else if (type === 'high_rank') {
        embed.setColor('#FFD700')
            .setTitle('⭐ High Rank Alert!')
            .setDescription(`${username} (Rank ${rank}) has joined the game!`)
            .setTimestamp();
    } else if (type === 'left') {
        embed.setColor('#FFA500')
            .setTitle('👋 Monitored Player Left!')
            .setDescription(`${username} has left the game!`)
            .setTimestamp();
    } else if (type === 'group_rank_info') {
        embed.setColor('#0099ff')
            .setTitle('ℹ️ Group Member Info')
            .setDescription(`${username} joined the game!`)
            .addFields(
                { name: 'Group Rank', value: `${rank}`, inline: true },
                { name: 'Role Name', value: roleName || 'Unknown', inline: true }
            )
            .setTimestamp();
    }

    if (groupName) {
        embed.addFields({ name: 'Group', value: groupName, inline: true });
    }

    embed.setFooter({ text: 'Roblox Player Monitor' });
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
async function checkGamePlayers() {
    if (!isMonitoring) return;

    try {
        const players = await getGamePlayers(CONFIG.ROBLOX_GAME_ID);
        const newPlayers = new Set(players.map(p => p.name));

        // Check for new players
        for (const player of newPlayers) {
            if (!currentPlayers.has(player)) {
                await handlePlayerJoin(player);
            }
        }

        // Check for players who left
        for (const player of currentPlayers) {
            if (!newPlayers.has(player)) {
                await handlePlayerLeave(player);
            }
        }

        currentPlayers = newPlayers;

        // Update bot status
        client.user.setActivity(`Monitoring ${currentPlayers.size} players`, { type: 3 });

    } catch (error) {
        console.error('Error checking game players:', error.message);
    }
}

async function handlePlayerJoin(username) {
    let shouldNotify = false;
    let notificationType = '';
    let rank = null;
    let roleName = null;

    // Check specific usernames
    if (CONFIG.NOTIFY_SPECIFIC_USERS && CONFIG.MONITORED_USERS.includes(username)) {
        shouldNotify = true;
        notificationType = 'specific_user';
    }

    // Check group memberships
    if (CONFIG.NOTIFY_GROUP_MEMBERS || CONFIG.NOTIFY_GROUP_RANKS) {
        const groupInfo = await getUserGroupInfo(username, CONFIG.GROUP_ID);
        if (groupInfo.isInGroup) {
            shouldNotify = true;
            rank = groupInfo.rank;
            roleName = groupInfo.roleName;

            if (CONFIG.NOTIFY_GROUP_RANKS && CONFIG.MONITORED_RANKS.includes(groupInfo.rank)) {
                notificationType = 'high_rank';
            } else {
                notificationType = 'group_member';
            }
        }
    }

    // NEW: Always show rank info for group members (even if not monitored)
    if (CONFIG.SHOW_GROUP_RANKS) {
        const groupInfo = await getUserGroupInfo(username, CONFIG.GROUP_ID);
        if (groupInfo.isInGroup) {
            const rankEmbed = createNotificationEmbed(username, 'group_rank_info', groupInfo.rank, groupInfo.roleName);
            await sendDiscordNotification(rankEmbed, true); // Ping everyone for group members
        }
    }

    if (shouldNotify) {
        const embed = createNotificationEmbed(username, notificationType, rank, roleName);
        await sendDiscordNotification(embed, true); // Ping everyone for monitored users

        console.log(`🔔 NOTIFICATION: ${username} joined the game!`);
    }
}

async function handlePlayerLeave(username) {
    let shouldNotify = false;

    // Check if leaving player was monitored
    if (CONFIG.MONITORED_USERS.includes(username)) {
        shouldNotify = true;
    } else {
        const groupInfo = await getUserGroupInfo(username, CONFIG.GROUP_ID);
        if (groupInfo.isInGroup) {
            shouldNotify = true;
        }
    }

    if (shouldNotify) {
        const embed = createNotificationEmbed(username, 'left');
        await sendDiscordNotification(embed, false); // Don't ping everyone when someone leaves

        console.log(`🔔 NOTIFICATION: ${username} left the game!`);
    }
}

// Discord bot events
client.once('ready', () => {
    console.log(`�� Discord bot logged in as ${client.user.tag}`);
    console.log(`�� Monitoring game ID: ${CONFIG.ROBLOX_GAME_ID}`);
    console.log(`👥 Monitored users: ${CONFIG.MONITORED_USERS.join(', ')}`);
    console.log(`🏢 Monitoring group ID: ${CONFIG.GROUP_ID}`);
    console.log(`⭐ Monitored ranks: ${CONFIG.MONITORED_RANKS.join(', ')}`);
    console.log(`ℹ️ Showing rank info for all group members: ${CONFIG.SHOW_GROUP_RANKS}`);
    console.log(`🔔 Pinging everyone on join: ${CONFIG.PING_EVERYONE}`);

    // Set bot status
    client.user.setActivity('Setting up monitoring...', { type: 3 });

    // Start monitoring
    isMonitoring = true;
    checkGamePlayers();

    // Schedule regular checks
    setInterval(checkGamePlayers, CONFIG.CHECK_INTERVAL * 1000);

    console.log('✅ Monitoring started successfully!');
});

// Bot commands - FIXED VERSION
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
                const statusEmbed = new EmbedBuilder()
                    .setColor('#0099ff')
                    .setTitle('📊 Monitor Status')
                    .addFields(
                        { name: 'Game ID', value: CONFIG.ROBLOX_GAME_ID, inline: true },
                        { name: 'Current Players', value: currentPlayers.size.toString(), inline: true },
                        { name: 'Monitoring', value: isMonitoring ? '✅ Active' : '❌ Inactive', inline: true },
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

            case 'players':
                const playersEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('�� Current Players')
                    .setDescription(currentPlayers.size > 0 ? 
                        currentPlayers.size + ' players online:\n' + Array.from(currentPlayers).join(', ') :
                        'No players currently online')
                    .setTimestamp();

                await message.reply({ embeds: [playersEmbed] });
                console.log('Players command executed successfully'); // Debug log
                break;

            case 'start':
                if (!isMonitoring) {
                    isMonitoring = true;
                    checkGamePlayers();
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
                        { name: '!players', value: 'Show current players online', inline: false },
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
