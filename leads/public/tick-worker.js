/* The power dialer's one-second tick, from a worker.

   A page timer in a tab the rep is not looking at is throttled by the browser
   — after a few minutes hidden, to about once a minute — so a 6-second
   countdown to the next lead turned into a minute or more. Timers in a
   dedicated worker are not held back that way. The page counts against a
   deadline, so even a late tick never rings early or twice. */
let timer = null;
onmessage = (e) => {
  if (e.data === "start" && !timer) timer = setInterval(() => postMessage("tick"), 1000);
  if (e.data === "stop" && timer) { clearInterval(timer); timer = null; }
};
