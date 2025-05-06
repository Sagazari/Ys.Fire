
document.getElementById('run').addEventListener('click', () => {
    const code = document.getElementById('code').value;
    const output = document.getElementById('output');
    output.textContent = 'Running Ys.Fire script...\n\n' + code + '\n\nOutput simulation here.';
});
