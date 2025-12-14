// ============================================
// REX CLOUD BACKEND - CALENDAR API
// ============================================
// Obsługuje różne kalendarze dla różnych użytkowników
// Każdy użytkownik ma swój własny plik .ics

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO_OWNER = process.env.REPO_OWNER || 'szewczykmarcin12-coder';
  const REPO_NAME = process.env.REPO_NAME || 'rex-calendar';
  
  // Pobierz nazwę pliku z query lub body (domyślnie kalendarz.ics dla kompatybilności)
  const fileName = req.query.file || req.body?.file || 'kalendarz.ics';
  
  // Walidacja nazwy pliku (tylko dozwolone znaki)
  if (!/^[a-zA-Z0-9_-]+\.ics$/.test(fileName)) {
    return res.status(400).json({ success: false, error: 'Invalid file name' });
  }

  const FILE_PATH = fileName;
  const API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

  try {
    if (req.method === 'GET') {
      // Pobierz kalendarz użytkownika
      const response = await fetch(API_URL, {
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'REX-Cloud-App'
        }
      });

      if (response.status === 404) {
        // Plik nie istnieje - utwórz pusty kalendarz
        const emptyCalendar = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//REX Cloud//PL
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:REX Cloud - ${fileName.replace('.ics', '')}
END:VCALENDAR`;
        
        // Utwórz nowy plik
        const createResponse = await fetch(API_URL, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'REX-Cloud-App',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: `Create calendar for user: ${fileName}`,
            content: Buffer.from(emptyCalendar).toString('base64')
          })
        });
        
        const createData = await createResponse.json();
        return res.status(200).json({
          success: true,
          content: emptyCalendar,
          sha: createData.content?.sha
        });
      }

      if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status}`);
      }

      const data = await response.json();
      const content = Buffer.from(data.content, 'base64').toString('utf-8');
      
      return res.status(200).json({
        success: true,
        content: content,
        sha: data.sha
      });

    } else if (req.method === 'POST') {
      // Zapisz kalendarz użytkownika
      const { content, sha, message } = req.body;

      if (!content) {
        return res.status(400).json({ success: false, error: 'Content is required' });
      }

      const body = {
        message: message || `Update calendar: ${fileName}`,
        content: Buffer.from(content).toString('base64')
      };

      // Dodaj SHA jeśli aktualizujemy istniejący plik
      if (sha) {
        body.sha = sha;
      }

      const response = await fetch(API_URL, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'REX-Cloud-App',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `GitHub API error: ${response.status}`);
      }

      const data = await response.json();
      
      return res.status(200).json({
        success: true,
        sha: data.content.sha,
        message: 'Calendar saved successfully'
      });

    } else {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
}
