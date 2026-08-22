fetch('https://api.render.com/v1/services/srv-d8voi8f7f7vs739d8igg/deploys', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer rnd_onCzvlA45DgzoQVvkhdFkPzzytig',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ clearCache: 'do_not_clear' })
}).then(r => r.json()).then(console.log).catch(console.error);
