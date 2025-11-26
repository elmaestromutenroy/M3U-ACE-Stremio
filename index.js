const http = require('http');
const fetch = require('node-fetch');
const crypto = require("crypto");

// --- 1. CONFIGURACIÓN ---
const DEFAULTS = {
    m3uUrl: "https://ipfs.io/ipns/k2k4r8oqlcjxsritt5mczkcn4mmvcmymbqw7113fz2flkrerfwfps004/data/listas/lista_iptv.m3u",
    targetIp: null, 
    defaultLogo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Blue_question_mark_icon.svg/1024px-Blue_question_mark_icon.svg.png"
};

// --- 2. GESTOR DE DATOS ---
class AceManager {
    constructor() {
        this.cache = new Map(); 
        this.lastUpdates = new Map();
    }

    async getChannels(config) {
        const cacheKey = `${config.m3u}::${config.ip || 'original'}`;
        const now = Date.now();

        if (this.cache.has(cacheKey) && (now - this.lastUpdates.get(cacheKey) < 36000 * 1000)) {
            return this.cache.get(cacheKey);
        }

        console.log(`--> [CARGA] IP Target: ${config.ip || 'Original'}`);
        
        try {
            const res = await fetch(config.m3u);
            if(res.ok) {
                const text = await res.text();
                const items = this.parseM3U(text, config.ip);
                this.cache.set(cacheKey, items);
                this.lastUpdates.set(cacheKey, now);
                console.log(`--> [OK] ${items.length} canales cacheados.`);
                return items;
            } else {
                console.log(`--> [ERROR] HTTP ${res.status}`);
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
                    let logo = attrs['tvg-logo'];
                    if (!logo || logo.trim() === "") logo = DEFAULTS.defaultLogo;
                    const group = attrs['group-title'] || 'OTROS';

                    currentItem = {
                        name: fullName,
                        logo: logo,
                        group: group,
                        id: 'ace_' + crypto.createHash('md5').update(fullName).digest('hex')
                    };
                }
            } else if (l && !l.startsWith('#') && currentItem) {
                let finalUrl = l;
                if (targetIp && targetIp.trim() !== "") {
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

// --- 3. SERVIDOR ---
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    try {
        // LOG CHIVATO: Ver qué pide Stremio exactamente
        console.log(`--> [PETICIÓN] URL: ${req.url}`);

        const u = new URL(req.url, `http://${req.headers.host}`);
        const pathSegments = u.pathname.split('/').filter(Boolean);

        // A. REDIRECCIÓN (SETUP)
        if (u.searchParams.has('ip') || u.searchParams.has('m3u')) {
            const configObj = {
                ip: u.searchParams.get('ip') || null,
                m3u: u.searchParams.get('m3u') || DEFAULTS.m3uUrl
            };
            const configStr = Buffer.from(JSON.stringify(configObj)).toString('base64url');
            console.log(`--> [REDIRECT] Config creada: ${configStr}`);
            res.writeHead(302, { 'Location': `/${configStr}/manifest.json` });
            res.end();
            return;
        }

        // B. PARSEO RUTA
        let config = { ip: null, m3u: DEFAULTS.m3uUrl };
        let resource = "";

        // Detectar si el primer segmento es configuración (Base64)
        if (pathSegments.length > 0 && pathSegments[0] !== 'manifest.json' && !pathSegments[0].includes('/')) {
            try {
                const decoded = Buffer.from(pathSegments[0], 'base64url').toString();
                const parsed = JSON.parse(decoded);
                // Verificamos que sea un JSON válido de config
                if (parsed.m3u || parsed.ip === null || parsed.ip) {
                    config = { ...config, ...parsed };
                    resource = pathSegments.slice(1).join('/');
                } else {
                    resource = pathSegments.join('/');
                }
            } catch {
                resource = pathSegments.join('/');
            }
        } else {
            resource = pathSegments.join('/');
        }
        
        if (resource === '') resource = 'manifest.json';

        // C. CARGA DE DATOS
        const channels = await manager.getChannels(config);
        const genres = [...new Set(channels.map(c => c.group))].sort();
        const dynamicGenres = ["TODOS", ...genres];

        // D. RESPUESTAS

        if (resource === 'manifest.json') {
            // ID DINÁMICO: Evita conflictos en Stremio si instalas varias IPs
            const safeIP = (config.ip || 'default').replace(/\./g, '-');
            
            const manifest = {
                id: `org.milista.ace.v10.${safeIP}`, // <--- CAMBIO CLAVE
                version: "1.0.10",
                name: config.ip ? `ACE (${config.ip})` : "ACE (Default)",
                description: "Lista Dinámica V10",
                description: `Fuente: ${config.m3u === DEFAULTS.m3uUrl ? 'Default' : config.m3u}`,
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

        if (resource.startsWith('catalog/')) {
            let selectedGenre = "TODOS";
            let searchTerm = "";

            // Limpieza de basura Stremio (.json, .jso)
            if (req.url.includes('genre=')) {
                const raw = req.url.split('genre=')[1].split('&')[0];
                selectedGenre = decodeURIComponent(raw).replace(/\.json$/, '').replace(/\.jso$/, '');
            }
            if (req.url.includes('search=')) {
                const raw = req.url.split('search=')[1].split('&')[0];
                searchTerm = decodeURIComponent(raw).replace(/\.json$/, '').toLowerCase();
            }

            console.log(`--> [CATALOG] Genero: '${selectedGenre}'`);

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
                    description: `Grupo: ${channel.group}\nIP: ${config.ip}`,
                    behaviorHints: { isLive: true }
                }
            }));
            return;
        }

        if (resource.startsWith('stream/')) {
            const id = resource.split('/').pop().replace('.json', '');
            const channel = channels.find(c => c.id === id);
            if (!channel) return res.end(JSON.stringify({ streams: [] }));

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
    console.log(`--> [SERVER V10] Puerto ${port}`);
});
