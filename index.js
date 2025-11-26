const { addonBuilder } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const http = require('http');
const crypto = require("crypto");

// --- 1. CONFIGURACIÓN POR DEFECTO ---
const DEFAULTS = {
    // Lista IPFS original
    m3uUrl: "https://ipfs.io/ipns/k2k4r8oqlcjxsritt5mczkcn4mmvcmymbqw7113fz2flkrerfwfps004/data/listas/lista_iptv.m3u",
    // IP por defecto: NULL significa "No tocar la lista original"
    targetIp: null, 
    defaultLogo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Blue_question_mark_icon.svg/1024px-Blue_question_mark_icon.svg.png"
};

// --- 2. GESTOR DE LISTAS (CORE) ---
class AceManager {
    constructor() {
        // Cache: Clave -> Array de Canales
        this.cache = new Map(); 
        this.lastUpdates = new Map();
    }

    // Obtiene la lista ya procesada según la configuración (IP y URL)
    async getChannels(config) {
        // Creamos una ID única para esta combinación de Lista + IP
        // Ejemplo: "http://lista.com::192.168.1.50" o "http://lista.com::original"
        const cacheKey = `${config.m3u}::${config.ip || 'original'}`;
        
        const now = Date.now();
        // Si existe en caché y tiene menos de 10 horas, devolverla
        if (this.cache.has(cacheKey) && (now - this.lastUpdates.get(cacheKey) < 36000 * 1000)) {
            return this.cache.get(cacheKey);
        }

        console.log(`--> [NUEVA CARGA] Bajando lista para configuración: IP=${config.ip || 'Original'}`);
        
        try {
            const res = await fetch(config.m3u);
            if (res.ok) {
                const text = await res.text();
                // AQUÍ PASAMOS LA IP PARA QUE SE PROCESE AL INICIO
                const items = this.parseM3U(text, config.ip);
                
                this.cache.set(cacheKey, items);
                this.lastUpdates.set(cacheKey, now);
                console.log(`--> [OK] ${items.length} canales procesados y guardados en caché.`);
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
                // --- LÓGICA DE REEMPLAZO IP (AL INICIO) ---
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

// --- 3. SERVIDOR HTTP (NAVAJA SUIZA) ---
const server = http.createServer(async (req, res) => {
    // CORS Headers
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

        // --- A. DETECTAR PARÁMETROS Y REDIRIGIR ---
        // Si entran por ?ip=... o ?m3u=..., creamos la configuración y redirigimos
        if (u.searchParams.has('ip') || u.searchParams.has('m3u')) {
            const configObj = {
                ip: u.searchParams.get('ip') || null, // Si no hay IP, null (Original)
                m3u: u.searchParams.get('m3u') || DEFAULTS.m3uUrl
            };
            
            const configStr = Buffer.from(JSON.stringify(configObj)).toString('base64url');
            res.writeHead(302, { 'Location': `/${configStr}/manifest.json` });
            res.end();
            return;
        }

        // --- B. LEER CONFIGURACIÓN DE LA URL ---
        let config = { ip: null, m3u: DEFAULTS.m3uUrl };
        let resource = "";

        // Caso Ruta Raíz o manifest limpio -> Configuración por defecto
        if (pathSegments.length === 0 || pathSegments[0] === 'manifest.json') {
            resource = pathSegments[0] || 'manifest.json';
        } 
        // Caso Ruta Configurada (/BASE64/...)
        else {
            try {
                const decoded = Buffer.from(pathSegments[0], 'base64url').toString();
                const parsed = JSON.parse(decoded);
                // Fusionar con defaults por seguridad
                config = { ...config, ...parsed };
                resource = pathSegments.slice(1).join('/');
            } catch {
                // Si falla al decodificar, asumimos que es una ruta normal
                resource = pathSegments.join('/');
            }
        }

        // --- C. OBTENER CANALES ---
        // El manager se encarga de dar la lista ya parcheada con la IP correcta
        const channels = await manager.getChannels(config);
        
        const genres = [...new Set(channels.map(c => c.group))].sort();
        const dynamicGenres = ["TODOS", ...genres];

        // --- D. RESPUESTAS STREMIO ---

        // 1. MANIFIESTO
        if (resource === 'manifest.json') {
            const manifest = {
                id: "org.ace.final.v8",
                version: "8.0.0",
                // Nombre dinámico para saber qué estás viendo
                name: config.ip ? `ACE (${config.ip})` : "ACE (Original)",
                description: `Fuente: ${config.m3u === DEFAULTS.m3uUrl ? 'IPFS Default' : 'Custom M3U'}`,
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

        // 2. CATALOGO
        if (resource.startsWith('catalog/')) {
            let selectedGenre = "TODOS";
            let searchTerm = "";

            // Limpieza de .json y extracción de parámetros
            if (req.url.includes('genre=')) {
                selectedGenre = decodeURIComponent(req.url.split('genre=')[1].split('&')[0]).replace('.json', '');
            }
            if (req.url.includes('search=')) {
                searchTerm = decodeURIComponent(req.url.split('search=')[1].split('&')[0]).replace('.json', '').toLowerCase();
            }

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

        // 3. META
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
                    description: `Grupo: ${channel.group}\nIP: ${config.ip || 'Original'}`,
                    behaviorHints: { isLive: true }
                }
            }));
            return;
        }

        // 4. STREAM
        if (resource.startsWith('stream/')) {
            const id = resource.split('/').pop().replace('.json', '');
            const channel = channels.find(c => c.id === id);
            if (!channel) return res.end(JSON.stringify({ streams: [] }));

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                streams: [{
                    url: channel.url, // La URL ya viene cambiada desde el manager
                    title: `Ver en ${config.ip || 'Original'}`,
                    behaviorHints: { notWebReady: true }
                }]
            }));
            return;
        }

        res.writeHead(404);
        res.end();

    } catch (err) {
        console.error("Error Server:", err);
        res.writeHead(500);
        res.end(JSON.stringify({ err: "Error interno" }));
    }
});

const port = process.env.PORT || 7000;
server.listen(port, () => {
    console.log(`--> [SERVER V8] Escuchando en puerto ${port}`);
});
