
const express = require('express');
const fs = require('fs');
const { exec } = require('child_process');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/run', (req, res) => {
  const code = req.body.code;
  fs.writeFileSync('script.py', code);
  exec('python script.py', (err, stdout, stderr) => {
    if (err) return res.json({ output: stderr });
    res.json({ output: stdout });
  });
});

app.listen(3000, () => console.log('Servidor rodando na porta 3000'));
