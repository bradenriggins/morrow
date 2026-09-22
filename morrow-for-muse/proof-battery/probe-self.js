fetch('/api/v1/users/self', {headers: {'Accept': 'application/json'}}).then(r => r.json().then(j => JSON.stringify({status: r.status, id: j.id, name: j.name}))).then(x => x)
