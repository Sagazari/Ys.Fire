const output = document.getElementById("output");

function runCode() {
  const code = document.getElementById("code").value;
  fetch("/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
  })
    .then(res => res.json())
    .then(data => {
      output.textContent = data.output;
    })
    .catch(err => {
      output.textContent = "Erro ao executar o código.";
    });
}

function saveCode() {
  const code = document.getElementById("code").value;
  localStorage.setItem("ys.bot.code", code);
  alert("Código salvo!");
}

window.onload = () => {
  const saved = localStorage.getItem("ys.bot.code");
  if (saved) document.getElementById("code").value = saved;
};
