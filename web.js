const express = require('express');
const path = require('path');

const app = express();

// Serve all static files (index.html, admin.html, host.html, terms.html, reset.html)
app.use(express.static(__dirname));

// Default route serves the homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`StudioRack website running on port ${PORT}`);
});
