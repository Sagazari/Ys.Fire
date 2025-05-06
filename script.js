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
      document.getElementById("run-btn").style.background = "#32CD32"; // Verde quando executado
      setTimeout(() => {
        document.getElementById("run-btn").style.background = "#FF6600"; // Resetando para original
      }, 500);
    })
    .catch(err => {
      output.textContent = "Erro ao executar o código.";
    });
}

function saveCode() {
  const code = document.getElementById("code").value;
  localStorage.setItem("ys.bot.code", code);
  alert("Código salvo!");
  document.getElementById("save-btn").style.background = "#32CD32"; // Verde quando salvo
  setTimeout(() => {
    document.getElementById("save-btn").style.background = "#FF6600"; // Resetando para original
  }, 500);
}

window.onload = () => {
  const saved = localStorage.getItem("ys.bot.code");
  if (saved) document.getElementById("code").value = saved;
};
