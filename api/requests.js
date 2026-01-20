// REX Cloud - API dla wniosków pracowników
// Endpoint: /api/requests

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_OWNER = process.env.GITHUB_OWNER || 'twoj-username';
  const GITHUB_REPO = process.env.GITHUB_REPO || 'rex-cloud-data';
  const FILE_PATH = 'requests.json';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ success: false, error: 'GITHUB_TOKEN not configured' });
  }

  const githubAPI = async (method, endpoint, body = null) => {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${endpoint}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(url, options);
    return response;
  };

  try {
    // GET - pobierz wszystkie wnioski
    if (req.method === 'GET') {
      const response = await githubAPI('GET', `/contents/${FILE_PATH}`);
      
      if (response.status === 404) {
        // Plik nie istnieje - zwróć pustą tablicę
        return res.status(200).json({ success: true, requests: [], sha: null });
      }

      if (!response.ok) {
        const error = await response.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const data = await response.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      const requests = JSON.parse(content);

      return res.status(200).json({ 
        success: true, 
        requests: requests,
        sha: data.sha 
      });
    }

    // POST - dodaj nowy wniosek
    if (req.method === 'POST') {
      const { request } = req.body;

      if (!request) {
        return res.status(400).json({ success: false, error: 'Missing request data' });
      }

      // Pobierz aktualne wnioski
      let currentRequests = [];
      let currentSha = null;

      const getResponse = await githubAPI('GET', `/contents/${FILE_PATH}`);
      
      if (getResponse.ok) {
        const data = await getResponse.json();
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        currentRequests = JSON.parse(content);
        currentSha = data.sha;
      }

      // Dodaj nowy wniosek z unikalnym ID
      const newRequest = {
        ...request,
        id: request.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        createdAt: request.createdAt || new Date().toISOString(),
        status: request.status || 'pending'
      };

      currentRequests.push(newRequest);

      // Zapisz do GitHub
      const saveBody = {
        message: `Add request: ${newRequest.id}`,
        content: Buffer.from(JSON.stringify(currentRequests, null, 2)).toString('base64')
      };
      if (currentSha) saveBody.sha = currentSha;

      const saveResponse = await githubAPI('PUT', `/contents/${FILE_PATH}`, saveBody);

      if (!saveResponse.ok) {
        const error = await saveResponse.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const saveData = await saveResponse.json();

      return res.status(200).json({ 
        success: true, 
        request: newRequest,
        sha: saveData.content.sha 
      });
    }

    // PUT - zaktualizuj wniosek (np. zmień status)
    if (req.method === 'PUT') {
      const { requestId, updates, sha } = req.body;

      if (!requestId || !updates) {
        return res.status(400).json({ success: false, error: 'Missing requestId or updates' });
      }

      // Pobierz aktualne wnioski
      const getResponse = await githubAPI('GET', `/contents/${FILE_PATH}`);
      
      if (!getResponse.ok) {
        return res.status(404).json({ success: false, error: 'Requests file not found' });
      }

      const data = await getResponse.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      let requests = JSON.parse(content);

      // Znajdź i zaktualizuj wniosek
      const index = requests.findIndex(r => r.id === requestId);
      if (index === -1) {
        return res.status(404).json({ success: false, error: 'Request not found' });
      }

      requests[index] = { 
        ...requests[index], 
        ...updates,
        updatedAt: new Date().toISOString()
      };

      // Zapisz do GitHub
      const saveResponse = await githubAPI('PUT', `/contents/${FILE_PATH}`, {
        message: `Update request: ${requestId} - ${updates.status || 'modified'}`,
        content: Buffer.from(JSON.stringify(requests, null, 2)).toString('base64'),
        sha: data.sha
      });

      if (!saveResponse.ok) {
        const error = await saveResponse.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const saveData = await saveResponse.json();

      return res.status(200).json({ 
        success: true, 
        request: requests[index],
        sha: saveData.content.sha 
      });
    }

    // DELETE - usuń wniosek
    if (req.method === 'DELETE') {
      const { requestId } = req.body;

      if (!requestId) {
        return res.status(400).json({ success: false, error: 'Missing requestId' });
      }

      // Pobierz aktualne wnioski
      const getResponse = await githubAPI('GET', `/contents/${FILE_PATH}`);
      
      if (!getResponse.ok) {
        return res.status(404).json({ success: false, error: 'Requests file not found' });
      }

      const data = await getResponse.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      let requests = JSON.parse(content);

      // Usuń wniosek
      requests = requests.filter(r => r.id !== requestId);

      // Zapisz do GitHub
      const saveResponse = await githubAPI('PUT', `/contents/${FILE_PATH}`, {
        message: `Delete request: ${requestId}`,
        content: Buffer.from(JSON.stringify(requests, null, 2)).toString('base64'),
        sha: data.sha
      });

      if (!saveResponse.ok) {
        const error = await saveResponse.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const saveData = await saveResponse.json();

      return res.status(200).json({ 
        success: true,
        sha: saveData.content.sha 
      });
    }

    // PATCH - bulk update (np. synchronizacja wielu wniosków)
    if (req.method === 'PATCH') {
      const { requests: newRequests } = req.body;

      if (!Array.isArray(newRequests)) {
        return res.status(400).json({ success: false, error: 'Invalid requests array' });
      }

      // Pobierz aktualne wnioski
      let currentSha = null;
      const getResponse = await githubAPI('GET', `/contents/${FILE_PATH}`);
      
      if (getResponse.ok) {
        const data = await getResponse.json();
        currentSha = data.sha;
      }

      // Zapisz wszystkie wnioski
      const saveBody = {
        message: `Bulk update: ${newRequests.length} requests`,
        content: Buffer.from(JSON.stringify(newRequests, null, 2)).toString('base64')
      };
      if (currentSha) saveBody.sha = currentSha;

      const saveResponse = await githubAPI('PUT', `/contents/${FILE_PATH}`, saveBody);

      if (!saveResponse.ok) {
        const error = await saveResponse.json();
        return res.status(500).json({ success: false, error: error.message });
      }

      const saveData = await saveResponse.json();

      return res.status(200).json({ 
        success: true,
        count: newRequests.length,
        sha: saveData.content.sha 
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed' });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
