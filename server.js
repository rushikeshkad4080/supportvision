const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 5000;
const JWT_SECRET = 'sv-hackathon-quantum-secret-2026';

app.use(cors());
app.use(express.json());

// --- DATA persistence STORAGE MATRIX ---
const users = [
  { id: 'usr_admin', email: 'admin@supportvision.com', password: 'password123', name: 'Sarah Jenkins (Director)', role: 'ADMIN' },
  { id: 'usr_agent', email: 'agent@supportvision.com', password: 'password123', name: 'Alex Mercer (Tier 2 Tech)', role: 'AGENT' }
];
const sessions = new Map(); 
const chatHistories = new Map(); // sessionId -> array of messages/files
const disconnectTimers = new Map(); // track reconnect windows

// --- GLOBAL OBSERVABILITY COUNTERS ---
let totalCallsCount = 0;
let caughtSystemErrors = 0;

// --- SECURITY PROTOCOL MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token validation failed' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token expired or corrupted signature' });
    req.user = user;
    next();
  });
}

// --- SECURE AUTHENTICATION ENDPOINT ---
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) {
    caughtSystemErrors++;
    return res.status(401).json({ error: 'Invalid terminal credentials' });
  }
  
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '2h' });
  res.json({ token, user: { id: user.id, role: user.role, name: user.name } });
});

// --- SESSION PROVISIONING PIPELINES ---
app.post('/api/sessions', authenticateToken, (req, res) => {
  const sessionId = 'SV-' + Math.floor(100000 + Math.random() * 900000);
  const inviteToken = 'AUTH-' + Math.random().toString(36).substring(2, 12).toUpperCase();
  
  const newSession = {
    id: sessionId,
    inviteToken,
    status: 'WAITING',
    agentId: req.user.id,
    agentName: req.user.name,
    createdAt: new Date().toISOString(),
    duration: 0
  };
  
  totalCallsCount++;
  sessions.set(sessionId, newSession);
  chatHistories.set(sessionId, []);
  res.status(201).json(newSession);
});

app.get('/api/sessions', (req, res) => {
  res.json(Array.from(sessions.values()));
});

app.post('/api/sessions/:id/end', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) {
    session.status = 'ENDED';
    session.duration = Math.floor((new Date() - new Date(session.createdAt)) / 1000);
    io.to(req.params.id).emit('session-ended');
  }
  res.json({ success: true });
});

// Mock File Storage Upload Target Channel Route
app.post('/api/files/upload', (req, res) => {
  // Simulates instant object storage assignment mapping
  const fileId = 'file_' + Date.now();
  res.json({ success: true, fileId });
});

// --- OBSERVABILITY TELEMETRY CAPTURE PORT ---
app.get('/metrics', (req, res) => {
  const list = Array.from(sessions.values());
  const activeCount = list.filter(s => s.status === 'ACTIVE').length;
  
  // Format matching standard Prometheus exposition layouts seamlessly
  let metricPayload = `# HELP supportvision_active_sessions Active calls right now\n`;
  metricPayload += `supportvision_active_sessions ${activeCount}\n`;
  metricPayload += `# HELP supportvision_connected_peers Socket pool depth\n`;
  metricPayload += `supportvision_connected_peers ${io.sockets.sockets.size}\n`;
  metricPayload += `# HELP supportvision_calls_total Cumulative calls\n`;
  metricPayload += `supportvision_calls_total ${totalCallsCount}\n`;
  metricPayload += `# HELP supportvision_system_errors Error rates accumulator\n`;
  metricPayload += `supportvision_system_errors ${caughtSystemErrors}\n`;

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.end(metricPayload);
});

// --- ADMIN CONTROL & METRICS ENDPOINTS ---
app.get('/api/admin/metrics', (req, res) => {
  const list = Array.from(sessions.values());
  res.json({
    activeSessions: list.filter(s => s.status === 'ACTIVE').length,
    connectedParticipants: io.sockets.sockets.size,
    totalCalls: list.length,
    bandwidthUsage: (list.filter(s => s.status === 'ACTIVE').length * 1.4 + 0.2).toFixed(1) + ' Mbps',
    systemLoad: '12.4%',
    errorRate: totalCallsCount > 0 ? ((caughtSystemErrors / totalCallsCount) * 100).toFixed(1) + '%' : '0.0%'
  });
});

// --- WEBRTC SIGNALING & FULL-DUPLEX CHAT ROUTER ---
io.on('connection', (socket) => {
  let activeRoom = null;
  let activeRole = null;
  let clientIdentity = "";

  socket.on('join-session', ({ sessionId, role, name }) => {
    activeRoom = sessionId;
    activeRole = role;
    clientIdentity = name;
    
    const session = sessions.get(sessionId);
    if (session) {
      const timerKey = `${sessionId}_${role}`;
      // 3.3 Grace Recovery Check
      if (disconnectTimers.has(timerKey)) {
        clearTimeout(disconnectTimers.get(timerKey));
        disconnectTimers.delete(timerKey);
        console.log(`[Reconnect] Peer ${name} safely re-entered within grace window.`);
      } else {
        session.status = 'ACTIVE';
      }
    }
    
    socket.join(sessionId);
    io.to(sessionId).emit('user-joined', { socketId: socket.id, role, name });
  });

  socket.on('send-message', ({ text, isFile, fileName, fileUrl, senderName, senderRole }) => {
    if (!activeRoom) return;
    const msg = { 
      id: 'msg_' + Date.now(), 
      text, 
      isFile: isFile || false,
      fileName: fileName || null,
      fileUrl: fileUrl || null,
      senderName, 
      senderRole, 
      createdAt: new Date().toISOString() 
    };
    const history = chatHistories.get(activeRoom) || [];
    history.push(msg);
    io.to(activeRoom).emit('message-received', msg);
  });

  socket.on('signal', (data) => {
    if (activeRoom) socket.to(activeRoom).emit('signal', data);
  });

  // 3.3 Connection Grace Window Setup Loop
  socket.on('disconnect', () => {
    if (!activeRoom || !activeRole) return;
    const timerKey = `${activeRoom}_${activeRole}`;
    
    // Hold operational metrics session parameters for a strict 60 seconds
    const timeout = setTimeout(() => {
      disconnectTimers.delete(timerKey);
      io.to(activeRoom).emit('user-left', { role: activeRole, name: clientIdentity });
      const session = sessions.get(activeRoom);
      if (session) {
        session.status = 'ENDED';
      }
    }, 60000); 
    disconnectTimers.set(timerKey, timeout);
  });
});

server.listen(PORT, () => console.log(`🚀 System Live Infrastructure Gateway mapping on port ${PORT}`));