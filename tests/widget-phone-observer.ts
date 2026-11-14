const phases: string[] = []
document.addEventListener('phone-fixture-event', event => {
  phases.push(String((event as CustomEvent).detail))
  const output = document.querySelector('#fixture-events')
  if (output) output.textContent = phases.slice(-20).join(' / ')
})
export {}
