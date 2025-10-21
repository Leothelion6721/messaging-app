const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// In-memory storage (in production, use a real database)
const users = new Map(); // userId -> { username, socketId, online }
const messages = new Map(); // chatId -> [messages array]
const chats = new Map(); // chatId -> { participants, type, name }

// Helper function to generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Helper to get chat ID between two users
function getChatId(user1, user2) {
    return [user1, user2].sort().join('-');
}

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);
    
    let currentUserId = null;

    // User login/register
    socket.on('login', (data) => {
        const { username } = data;
        
        // Check if username already exists
        let userId = null;
        for (const [id, user] of users.entries()) {
            if (user.username === username) {
                userId = id;
                break;
            }
        }

        // Create new user if doesn't exist
        if (!userId) {
            userId = generateId();
            users.set(userId, {
                username,
                socketId: socket.id,
                online: true,
                createdAt: Date.now()
            });
        } else {
            // Update existing user
            const user = users.get(userId);
            user.socketId = socket.id;
            user.online = true;
        }

        currentUserId = userId;
        
        // Send user data and existing chats
        const userChats = [];
        for (const [chatId, chat] of chats.entries()) {
            if (chat.participants.includes(userId)) {
                const chatMessages = messages.get(chatId) || [];
                const lastMessage = chatMessages[chatMessages.length - 1];
                
                // Get other participant info
                const otherParticipantId = chat.participants.find(p => p !== userId);
                const otherParticipant = users.get(otherParticipantId);
                
                userChats.push({
                    chatId,
                    name: chat.name || otherParticipant?.username || 'Unknown',
                    type: chat.type,
                    participants: chat.participants,
                    lastMessage: lastMessage ? {
                        text: lastMessage.text,
                        time: lastMessage.timestamp
                    } : null,
                    online: otherParticipant?.online || false,
                    unread: 0 // Simplified for demo
                });
            }
        }

        socket.emit('login-success', {
            userId,
            username,
            chats: userChats
        });

        // Notify others that user is online
        socket.broadcast.emit('user-online', { userId, username });
        
        console.log(`User logged in: ${username} (${userId})`);
    });

    // Get all online users
    socket.on('get-users', () => {
        const onlineUsers = [];
        for (const [userId, user] of users.entries()) {
            if (userId !== currentUserId) {
                onlineUsers.push({
                    userId,
                    username: user.username,
                    online: user.online
                });
            }
        }
        socket.emit('users-list', onlineUsers);
    });

    // Start new chat
    socket.on('start-chat', (data) => {
        const { targetUserId } = data;
        
        if (!currentUserId || !targetUserId) return;

        const chatId = getChatId(currentUserId, targetUserId);
        
        // Create chat if doesn't exist
        if (!chats.has(chatId)) {
            chats.set(chatId, {
                participants: [currentUserId, targetUserId],
                type: 'private',
                createdAt: Date.now()
            });
            messages.set(chatId, []);
        }

        const targetUser = users.get(targetUserId);
        
        socket.emit('chat-started', {
            chatId,
            name: targetUser?.username || 'Unknown',
            type: 'private',
            participants: [currentUserId, targetUserId],
            online: targetUser?.online || false,
            messages: messages.get(chatId) || []
        });

        // Notify the other user if they're online
        if (targetUser && targetUser.online) {
            const currentUser = users.get(currentUserId);
            io.to(targetUser.socketId).emit('new-chat', {
                chatId,
                name: currentUser?.username || 'Unknown',
                type: 'private',
                participants: [currentUserId, targetUserId],
                online: true
            });
        }
    });

    // Send message
    socket.on('send-message', (data) => {
        const { chatId, text } = data;
        
        if (!currentUserId || !chatId || !text) return;

        const chat = chats.get(chatId);
        if (!chat || !chat.participants.includes(currentUserId)) return;

        const message = {
            id: generateId(),
            chatId,
            senderId: currentUserId,
            senderName: users.get(currentUserId)?.username || 'Unknown',
            text,
            timestamp: Date.now(),
            read: false
        };

        // Store message
        const chatMessages = messages.get(chatId) || [];
        chatMessages.push(message);
        messages.set(chatId, chatMessages);

        // Send to all participants
        chat.participants.forEach(participantId => {
            const participant = users.get(participantId);
            if (participant && participant.online && participant.socketId) {
                io.to(participant.socketId).emit('new-message', {
                    chatId,
                    message: {
                        id: message.id,
                        text: message.text,
                        senderId: message.senderId,
                        senderName: message.senderName,
                        timestamp: message.timestamp,
                        sent: participantId === currentUserId
                    }
                });
            }
        });

        console.log(`Message sent in chat ${chatId}: ${text}`);
    });

    // Typing indicator
    socket.on('typing', (data) => {
        const { chatId, isTyping } = data;
        
        if (!currentUserId || !chatId) return;

        const chat = chats.get(chatId);
        if (!chat) return;

        // Notify other participants
        chat.participants.forEach(participantId => {
            if (participantId !== currentUserId) {
                const participant = users.get(participantId);
                if (participant && participant.online && participant.socketId) {
                    io.to(participant.socketId).emit('user-typing', {
                        chatId,
                        userId: currentUserId,
                        username: users.get(currentUserId)?.username,
                        isTyping
                    });
                }
            }
        });
    });

    // Create group chat
    socket.on('create-group', (data) => {
        const { name, participantIds } = data;
        
        if (!currentUserId || !name || !participantIds || participantIds.length === 0) return;

        const chatId = generateId();
        const allParticipants = [currentUserId, ...participantIds];

        chats.set(chatId, {
            participants: allParticipants,
            type: 'group',
            name,
            createdAt: Date.now(),
            createdBy: currentUserId
        });
        messages.set(chatId, []);

        // Notify all participants
        allParticipants.forEach(participantId => {
            const participant = users.get(participantId);
            if (participant && participant.online && participant.socketId) {
                io.to(participant.socketId).emit('new-chat', {
                    chatId,
                    name,
                    type: 'group',
                    participants: allParticipants,
                    online: false
                });
            }
        });

        console.log(`Group created: ${name} (${chatId})`);
    });

    // Get messages for a chat
    socket.on('get-messages', (data) => {
        const { chatId } = data;
        
        if (!currentUserId || !chatId) return;

        const chat = chats.get(chatId);
        if (!chat || !chat.participants.includes(currentUserId)) return;

        const chatMessages = messages.get(chatId) || [];
        
        socket.emit('messages-loaded', {
            chatId,
            messages: chatMessages.map(msg => ({
                id: msg.id,
                text: msg.text,
                senderId: msg.senderId,
                senderName: msg.senderName,
                timestamp: msg.timestamp,
                sent: msg.senderId === currentUserId
            }))
        });
    });

    // Disconnect
    socket.on('disconnect', () => {
        if (currentUserId) {
            const user = users.get(currentUserId);
            if (user) {
                user.online = false;
                
                // Notify others that user is offline
                socket.broadcast.emit('user-offline', {
                    userId: currentUserId,
                    username: user.username
                });
                
                console.log(`User disconnected: ${user.username} (${currentUserId})`);
            }
        }
        console.log('Client disconnected:', socket.id);
    });
});

// REST API endpoints (optional)
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        chats: chats.size,
        messages: Array.from(messages.values()).reduce((sum, msgs) => sum + msgs.length, 0)
    });
});

// Serve the frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp Clone Server running on port ${PORT}`);
    console.log(`📱 Open multiple browser tabs to test real-time messaging!`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});
