const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { VM } = require('vm2');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname + "/public"));

app.post('/run', (req, res) => {
  const code = req.body.code;
  const vm = new VM({ timeout: 1000, sandbox: {} });
  try {
    const result = vm.run(code);
    res.json({ output: String(result) });
  } catch (e) {
    res.json({ output: "Erro: " + e.message });
  }
});

app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
