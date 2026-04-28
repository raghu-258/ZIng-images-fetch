require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const probeRoutes  = require('./routes/probe');
const sheetRoutes  = require('./routes/sheet');
const uploadRoutes = require('./routes/upload');
const jsonRoutes   = require('./routes/json');
const filesRoutes  = require('./routes/files');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* API routes */
app.use('/api/probe',  probeRoutes);
app.use('/api/sheet',  sheetRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/json',   jsonRoutes);
app.use('/api/files',  filesRoutes);

/* Serve frontend */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n  ◈ HS Uploader running → http://localhost:${PORT}\n`);
});
