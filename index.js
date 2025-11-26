const http = require('http');
const fetch = require('node-fetch');
const crypto = require("crypto");

// --- 1. CONFIGURACIÓN POR DEFECTO ---
const DEFAULTS = {
    // Lista IPFS original
    m3uUrl: "https://ipfs.io/ipns/k2k4r8oqlcjxsritt5mczkcn4mmvcmymbqw7113fz2flkrerfwfps004/data/listas/lista_iptv.m3u",
    // IP por defecto: null significa "No tocar la lista original"
    targetIp: null, 
    defaultLogo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Blue_question_mark_icon.svg/1024px-Blue_question_mark_icon.svg.png"
};

// --- 2. GESTOR DE LISTAS (CORE) ---
class AceManager {
    constructor() {
        // Cache: Guardará versiones procesadas de la lista
        // Clave: "URL::IP" -> Valor: Array de Canales
        this.cache = new Map(); 
        this.lastUpdates = new Map();
    }

    // Obtiene la lista ya procesada según la configuración
    async getChannels(config) {
        // ID única para esta combinación de Lista + IP
        // Ejemplo: "http://mi-lista.com::192.168.1.50"
        const cacheKey = `${config.m3u}::${config.ip || 'original'}`;
        const now = Date.now();

        // Si existe en caché y tiene menos de 10 horas, devolverla directo (RÁPIDO)
        if (this.cache.has(cacheKey) && (now - this.lastUpdates.get(cacheKey) < 36000 * 1000)) {
            return this.cache.get(cacheKey);
        }

        console.log(`--> [NUEVA CARGA] Procesando lista...`);
        console.log(`    Fuente: ${config.m3u}`);
        console.log(`    IP Target: ${config.ip || 'Original (Sin cambios)'}`);
        
        try {
            const res = await fetch(config.m3u);
            if (res.ok) {
                const text = await res.text();
                // AQUÍ PASAMOS LA IP PARA QUE SE REEMPLACE UNA SOLA VEZ AL INICIO
                const items = this.parseM3U(text, config.ip);
                
                // Guardamos la lista ya cocinada en caché
                this.cache.set(cacheKey, items);
                this.lastUpdates.set(cacheKey, now);
                console.log(`--> [OK] ${items.length} canales procesados y cacheados.`);
                return items;
            } else {
                console.log(`--> [ERROR] HTTP ${res.status} al bajar lista.`);
                return [];
            }
        } catch (e) {
            console.log(`--> [ERROR] Red: ${e.message}`);
            return [];
        }
    }

    parseM3U(content, targetIp) {
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;

        lines.forEach(line => {
            const l = line.trim();
            if (l.startsWith('#EXTINF:')) {
                const info = l.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (info) {
                    const attrs = {};
                    const attrRaw = info[2] || '';
                    const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
                    let m;
                    while ((m = regex.exec(attrRaw)) !== null) attrs[m[1]] = m[2];
                    
                    let fullName = (info[3] || '').trim();
                    
                    // Fallback de Logo
                    let logo = attrs['tvg-logo'];
                    if (!logo || logo.trim() === "") logo = DEFAULTS.defaultLogo;
                    
                    // Fallback de Grupo
                    const group = attrs['group-title'] || 'OTROS';

                    currentItem = {
                        name: fullName,
                        logo: logo,
                        group: group,
                        id: 'ace_' + crypto.createHash('md5').update(fullName).digest('hex')
                    };
                }
            } else if (l && !l.startsWith('#') && currentItem) {
                // --- LÓGICA DE REEMPLAZO IP (AQUÍ OCURRE LA MAGIA) ---
                let finalUrl = l;
                
                // Solo reemplazamos si el usuario pidió una IP específica
                if (targetIp && targetIp.trim() !== "") {
                    // Reemplaza 127.0.0.1 por la IP del usuario
                    finalUrl = l.replace('127.0.0.1', targetIp);
                }
                
                currentItem.url = finalUrl;
                items.push(currentItem);
                currentItem = null;
            }
        });
        return items;
    }
}

const manager = new AceManager();

// --- 3. SERVIDOR HTTP PERSONALIZADO (Navaja Suiza) ---
// Usamos http puro para tener control total de las rutas y redirecciones
const server = http.createServer(async (req, res) => {
    // CORS Headers (Vital para Stremio Web)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    try {
        const u = new URL(req.url, `http://${req.headers.host}`);
        const pathSegments = u.pathname.split('/').filter(Boolean);

        // --- A. DETECTAR PARÁMETROS Y REDIRIGIR (INSTALACIÓN) ---
        // Si entran por ?ip=... o ?m3u=..., creamos la configuración y redirigimos
        if (u.searchParams.has('ip') || u.searchParams.has('m3u')) {
            const configObj = {
                ip: u.searchParams.get('ip') || null, // Si no hay IP, null (Original)
                m3u: u.searchParams.get('m3u') || DEFAULTS.m3uUrl
            };
            
            // Convertimos config a base64 para que sea una URL válida y persistente
            const configStr = Buffer.from(JSON.stringify(configObj)).toString('base64url');
            
            // Redirección 302 a la nueva ruta "congelada"
            res.writeHead(302, { 'Location': `/${configStr}/manifest.json` });
            res.end();
            return;
        }

        // --- B. LEER CONFIGURACIÓN DE LA RUTA ---
        let config = { ip: null, m3u: DEFAULTS.m3uUrl };
        let resource = "";

        // Caso 1: Ruta Raíz -> Configuración por defecto (IPFS + IP Original)
        if (pathSegments.length === 0 || pathSegments[0] === 'manifest.json') {
            resource = pathSegments[0] || 'manifest.json';
        } 
        // Caso 2: Ruta Configurada (/BASE64/...)
        else {
            try {
                // Intentamos decodificar el primer segmento
                const decoded = Buffer.from(pathSegments[0], 'base64url').toString();
                const parsed = JSON.parse(decoded);
                // Fusionamos con defaults
                config = { ...config, ...parsed };
                // El resto de la ruta es el recurso (catalog, meta, stream)
                resource = pathSegments.slice(1).join('/');
            } catch {
                // Si falla, asumimos ruta normal
                resource = pathSegments.join('/');
            }
        }
        
        if (resource === '') resource = 'manifest.json';

        // --- C. PREPARAR DATOS ---
        // Pedimos al manager los canales ya procesados para esta config
        const channels = await manager.getChannels(config);
        
        // Sacamos géneros dinámicos de esta lista específica
        const genres = [...new Set(channels.map(c => c.group))].sort();
        const dynamicGenres = ["TODOS", ...genres];

        // --- D. RESPONDER A STREMIO (MANUALMENTE) ---

        // 1. MANIFIESTO
        if (resource === 'manifest.json') {
            const manifest = {
                id: "org.milista.ace.v9",
                version: "1.0.9",
                // Nombre dinámico para que sepas qué configuración tienes instalada
                name: config.ip ? `ACE (${config.ip})` : "ACE (Original)",
                description: `Fuente: ${config.m3u === DEFAULTS.m3uUrl ? 'Default' : 'Custom'}`,
                resources: ["catalog", "meta", "stream"],
                types: ["AceStream"],
                catalogs: [{
                    type: "AceStream",
                    id: "mi_lista",
                    name: "Mi Lista",
                    extra: [
                        { name: "genre", isRequired: false, options: dynamicGenres },
                        { name: "search" }, { name: "skip" }
                    ],
                    genres: dynamicGenres
                }],
                idPrefixes: ["ace_"]
            };
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(manifest));
            return;
        }

        // 2. CATÁLOGO (LISTA DE CANALES)
        if (resource.startsWith('catalog/')) {
            let selectedGenre = "TODOS";
            let searchTerm = "";

            // Limpieza de .json y bug de Stremio
            if (req.url.includes('genre=')) {
                const rawGenre = req.url.split('genre=')[1].split('&')[0];
                selectedGenre = decodeURIComponent(rawGenre).replace('.json', '').replace('.jso', '');
            }
            if (req.url.includes('search=')) {
                const rawSearch = req.url.split('search=')[1].split('&')[0];
                searchTerm = decodeURIComponent(rawSearch).replace('.json', '').toLowerCase();
            }

            console.log(`--> [REQ] Catálogo: ${selectedGenre} | IP: ${config.ip || 'Orig'}`);

            let results = channels;

            if (searchTerm) {
                results = results.filter(c => c.name.toLowerCase().includes(searchTerm));
            } else if (selectedGenre !== "TODOS") {
                results = results.filter(c => c.group === selectedGenre);
            }

            const metas = results.map(c => ({
                id: c.id,
                type: "AceStream",
                name: c.name,
                poster: c.logo,
                description: c.group
            }));

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ metas: metas }));
            return;
        }

        // 3. META (DETALLES)
        if (resource.startsWith('meta/')) {
            const id = resource.split('/').pop().replace('.json', '');
            const channel = channels.find(c => c.id === id);
            if (!channel) return res.end(JSON.stringify({ meta: null }));

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                meta: {
                    id: channel.id,
                    type: "AceStream",
                    name: channel.name,
                    poster: channel.logo,
                    background: channel.logo,
                    description: `Grupo: ${channel.group}\nIP Config: ${config.ip || 'Original'}`,
                    behaviorHints: { isLive: true }
                }
            }));
            return;
        }

        // 4. STREAM (VIDEO)
        if (resource.startsWith('stream/')) {
            const id = resource.split('/').pop().replace('.json', '');
            const channel = channels.find(c => c.id === id);
            if (!channel) return res.end(JSON.stringify({ streams: [] }));

            // La URL ya viene cambiada desde el manager si hizo falta
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                streams: [{
                    url: channel.url, 
                    title: `Ver en ${config.ip || 'Original'}`,
                    behaviorHints: { notWebReady: true }
                }]
            }));
            return;
        }

        // 404 Not Found
        res.writeHead(404);
        res.end();

    } catch (err) {
        console.error("Server Error:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ err: "Error interno" }));
    }
});

const port = process.env.PORT || 7000;
server.listen(port, () => {
    console.log(`--> [SERVER V9] Escuchando en puerto ${port}`);
});
