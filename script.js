
const runBtn = document.getElementById("runBtn");
const saveBtn = document.getElementById("saveBtn");
const codeArea = document.getElementById("codeArea");
const consoleOutput = document.getElementById("consoleOutput");

runBtn.addEventListener("click", () => {
    try {
        const result = eval(codeArea.value);
        consoleOutput.textContent = String(result);
    } catch (e) {
        consoleOutput.textContent = "Erro: " + e.message;
    }
});

saveBtn.addEventListener("click", () => {
    localStorage.setItem("savedBotCode", codeArea.value);
    alert("Código salvo!");
});

window.addEventListener("load", () => {
    const saved = localStorage.getItem("savedBotCode");
    if (saved) codeArea.value = saved;
});
