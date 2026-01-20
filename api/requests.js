export default async function handler(request, response) {
  // CORS
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (request.method === 'OPTIONS') {
    return response.status(200).end();
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER || 'szewczykmarcin12-coder';
  const REPO_NAME = process.env.REPO_NAME || 'rex-calendar';
  const FILE_PATH = 'requests.json'; // Plik z wnioskami

  if (!GITHUB_TOKEN) {
    return response.status(500).json({ success: false, error: 'GitHub token not configured' });
  }

  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

  const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'REX-Cloud'
  };

  try {
    // GET - pobierz wszystkie wnioski
    if (request.method === 'GET') {
      const res = await fetch(url, { headers: githubHeaders });

      if (res.status === 404) {
        // Plik nie istnieje - zwróć pustą tablicę
        return response.status(200).json({ success: true, requests: [], sha: null });
      }

      if (!res.ok) {
        return response.status(res.status).json({ success: false, error: 'GitHub fetch failed' });
      }

      const data = await res.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const requests = JSON.parse(content);

      return response.status(200).json({
        success: true,
        requests: requests,
        sha: data.sha
      });
    }

    // POST - dodaj nowy wniosek
    if (request.method === 'POST') {
      const { request: newRequest } = request.body;

      if (!newRequest) {
        return response.status(400).json({ success: false, error: 'Missing request data' });
      }

      // Pobierz aktualne wnioski
      let currentRequests = [];
      let currentSha = null;

      const getRes = await fetch(url, { headers: githubHeaders });
      
      if (getRes.ok) {
        const data = await getRes.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        currentRequests = JSON.parse(content);
        currentSha = data.sha;
      }

      // Dodaj nowy wniosek z unikalnym ID
      const requestToAdd = {
        ...newRequest,
        id: newRequest.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        createdAt: newRequest.createdAt || new Date().toISOString(),
        status: newRequest.status || 'pending'
      };

      currentRequests.push(requestToAdd);

      // Zapisz do GitHub
      const saveBody = {
        message: `Add request: ${requestToAdd.id}`,
        content: Buffer.from(JSON.stringify(currentRequests, null, 2)).toString('base64')
      };
      if (currentSha) saveBody.sha = currentSha;

      const saveRes = await fetch(url, {
        method: 'PUT',
        headers: { ...githubHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(saveBody)
      });

      if (!saveRes.ok) {
        const errorText = await saveRes.text();
        return response.status(saveRes.status).json({ success: false, error: 'GitHub save failed: ' + errorText });
      }

      const saveData = await saveRes.json();

      return response.status(200).json({
        success: true,
        request: requestToAdd,
        sha: saveData.content.sha
      });
    }

    // PUT - zaktualizuj wniosek (np. zmień status)
    if (request.method === 'PUT') {
      const { requestId, updates } = request.body;

      if (!requestId || !updates) {
        return response.status(400).json({ success: false, error: 'Missing requestId or updates' });
      }

      // Pobierz aktualne wnioski
      const getRes = await fetch(url, { headers: githubHeaders });
      
      if (!getRes.ok) {
        return response.status(404).json({ success: false, error: 'Requests file not found' });
      }

      const data = await getRes.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      let requests = JSON.parse(content);

      // Znajdź i zaktualizuj wniosek
      const index = requests.findIndex(r => r.id === requestId);
      if (index === -1) {
        return response.status(404).json({ success: false, error: 'Request not found' });
      }

      requests[index] = {
        ...requests[index],
        ...updates,
        updatedAt: new Date().toISOString()
      };

      // Zapisz do GitHub
      const saveRes = await fetch(url, {
        method: 'PUT',
        headers: { ...githubHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Update request: ${requestId} - ${updates.status || 'modified'}`,
          content: Buffer.from(JSON.stringify(requests, null, 2)).toString('base64'),
          sha: data.sha
        })
      });

      if (!saveRes.ok) {
        return response.status(saveRes.status).json({ success: false, error: 'GitHub update failed' });
      }

      const saveData = await saveRes.json();

      return response.status(200).json({
        success: true,
        request: requests[index],
        sha: saveData.content.sha
      });
    }

    // DELETE - usuń wniosek
    if (request.method === 'DELETE') {
      const { requestId } = request.body;

      if (!requestId) {
        return response.status(400).json({ success: false, error: 'Missing requestId' });
      }

      // Pobierz aktualne wnioski
      const getRes = await fetch(url, { headers: githubHeaders });
      
      if (!getRes.ok) {
        return response.status(404).json({ success: false, error: 'Requests file not found' });
      }

      const data = await getRes.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      let requests = JSON.parse(content);

      // Usuń wniosek
      const originalLength = requests.length;
      requests = requests.filter(r => r.id !== requestId);

      if (requests.length === originalLength) {
        return response.status(404).json({ success: false, error: 'Request not found' });
      }

      // Zapisz do GitHub
      const saveRes = await fetch(url, {
        method: 'PUT',
        headers: { ...githubHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Delete request: ${requestId}`,
          content: Buffer.from(JSON.stringify(requests, null, 2)).toString('base64'),
          sha: data.sha
        })
      });

      if (!saveRes.ok) {
        return response.status(saveRes.status).json({ success: false, error: 'GitHub delete failed' });
      }

      const saveData = await saveRes.json();

      return response.status(200).json({
        success: true,
        sha: saveData.content.sha
      });
    }

    return response.status(405).json({ success: false, error: 'Method not allowed' });

  } catch (error) {
    return response.status(500).json({ success: false, error: error.message });
  }
}
