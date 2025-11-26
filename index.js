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

        console.log(`--> [CARGA] Procesando lista...`);
        console.log(`    IP Target: ${config.ip || 'Original (127.0.0.1)'} | URL: ${config.m3u}`);
        
        try {
            const res = await fetch(config.m3u);
            if(res.ok) {
                const text = await res.text();
                // Pasamos la IP para que se reemplace AHORA
                const items = this.parseM3U(text, config.ip);
                
                this.cache.set(cacheKey, items);
                this.lastUpdates.set(cacheKey, now);
                console.log(`--> [OK] ${items.length} canales listos.`);
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
                // LÓGICA DE REEMPLAZO DE IP
                let finalUrl = l;
                if (targetIp && targetIp.trim() !== "") {
                    // Aquí se hace la magia: cambiamos 127.0.0.1 por tu IP
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
        const u = new URL(req.url, `http://${req.headers.host}`);
        const pathSegments = u.pathname.split('/').filter(Boolean);

        // A. DETECCIÓN DE PARÁMETROS PARA REDIRECCIÓN (SOLO EN INSTALL)
        // Si estamos en la raiz o manifest.json y hay params, redirigimos para "congelar" la config
        const isInstallUrl = pathSegments.length === 0 || (pathSegments.length === 1 && pathSegments[0] === 'manifest.json');
        
        if ((u.searchParams.has('ip') || u.searchParams.has('m3u')) && isInstallUrl) {
            const configObj = {
                ip: u.searchParams.get('ip') || null,
                m3u: u.searchParams.get('m3u') || DEFAULTS.m3uUrl
            };
            const configStr = Buffer.from(JSON.stringify(configObj)).toString('base64url');
            console.log(`--> [REDIRECT] Configurando entorno...`);
            res.writeHead(302, { 'Location': `/${configStr}/manifest.json` });
            res.end();
            return;
        }

        // B. LEER CONFIGURACIÓN (HÍBRIDA)
        let config = { ip: null, m3u: DEFAULTS.m3uUrl };
        let resource = "";

        // 1. Intentar leer desde la RUTA (Base64)
        let configFoundInPath = false;
        if (pathSegments.length > 0 && pathSegments[0] !== 'manifest.json' && !pathSegments[0].includes('/')) {
            try {
                const decoded = Buffer.from(pathSegments[0], 'base64url').toString();
                const parsed = JSON.parse(decoded);
                config = { ...config, ...parsed };
                resource = pathSegments.slice(1).join('/');
                configFoundInPath = true;
            } catch {
                resource = pathSegments.join('/');
            }
        } else {
            resource = pathSegments.join('/');
        }

        // 2. Intentar leer desde PARÁMETROS URL (Fallback vital)
        // Si no encontramos config en el path, miramos si Stremio nos la manda en ?ip=
        if (!configFoundInPath) {
            if (u.searchParams.has('ip')) config.ip = u.searchParams.get('ip');
            if (u.searchParams.has('m3u')) config.m3u = u.searchParams.get('m3u');
        }
        
        if (resource === '') resource = 'manifest.json';

        // C. CARGA DE DATOS
        // Ahora 'config' tiene la IP correcta sea cual sea el método que usó Stremio
        const channels = await manager.getChannels(config);
        const genres = [...new Set(channels.map(c => c.group))].sort();
        const dynamicGenres = ["TODOS", ...genres];

        // D. RESPUESTAS

        if (resource === 'manifest.json') {
            const safeIP = (config.ip || 'default').replace(/\./g, '-');
            const manifest = {
                id: `org.milista.ace.v12.${safeIP}`, 
                version: "1.0.12",
                name: config.ip ? `ACE (${config.ip})` : "ACE (Original)",
                description: `Fuente: ${config.m3u === DEFAULTS.m3uUrl ? 'Default' : 'Personalizada'}`,
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

            // Limpieza Agresiva de URL
            if (req.url.includes('genre=')) {
                const raw = req.url.split('genre=')[1].split('.json')[0].split('&')[0].split('?')[0];
                selectedGenre = decodeURIComponent(raw);
            }
            if (req.url.includes('search=')) {
                const raw = req.url.split('search=')[1].split('.json')[0].split('&')[0].split('?')[0];
                searchTerm = decodeURIComponent(raw).toLowerCase();
            }

            console.log(`--> [CATALOG] Genero: '${selectedGenre}' | IP Usada: ${config.ip || 'Original'}`);

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
            const id = resource.split('/').pop().replace('.json', '').split('?')[0];
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
                    description: `Grupo: ${channel.group}\nIP: ${config.ip || 'Original'}`,
                    behaviorHints: { isLive: true }
                }
            }));
            return;
        }

        if (resource.startsWith('stream/')) {
            const id = resource.split('/').pop().replace('.json', '').split('?')[0];
            const channel = channels.find(c => c.id === id);
            if (!channel) return res.end(JSON.stringify({ streams: [] }));

            // La URL ya viene cambiada desde el manager (getChannels la procesó)
            // Pero por seguridad, hacemos un log para ver qué estamos mandando
            // console.log(`--> [STREAM] Entregando URL: ${channel.url}`);

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
    console.log(`--> [SERVER V12] Puerto ${port}`);
});
