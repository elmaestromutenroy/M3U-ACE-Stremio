const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const xml2js = require('xml2js');
const crypto = require("crypto");

// --- 1. CONFIGURACIÓN ---
const CONFIG = {
    // Tu lista remota
    m3uUrl: "http://coincity.tk/f/acem3u.m3u",
    // EPGs (Se intentarán cargar para cruzar datos)
     epgUrls: [
    //    "https://raw.githubusercontent.com/davidmuma/EPG_dobleM/refs/heads/master/guiatv.xml",
    //    "https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml"
    ]
};

// --- 2. GESTOR DE DATOS (Clase interna) ---
class AceManager {
    constructor() {
        this.channels = [];
        this.epgData = {};
    }

    // Función principal de actualización
    async updateData() {
        console.log("--> [UPDATE] Iniciando actualización...");
        
        // A. Descargar Lista M3U
        try {
            const res = await fetch(CONFIG.m3uUrl);
            if(res.ok) {
                const text = await res.text();
                this.channels = this.parseM3U(text);
                console.log(`--> [LISTA] Cargada: ${this.channels.length} canales.`);
            } else {
                console.log(`--> [ERROR] No se pudo cargar la lista: ${res.status}`);
            }
        } catch (e) {
            console.log("--> [ERROR] Fallo de red lista:", e.message);
        }

        // B. Descargar EPGs
        const parser = new xml2js.Parser();
        for (const url of CONFIG.epgUrls) {
            try {
                const res = await fetch(url);
                if(res.ok) {
                    const text = await res.text();
                    const result = await parser.parseStringPromise(text);
                    if (result.tv && result.tv.programme) {
                        result.tv.programme.forEach(prog => {
                            const channelId = prog.$.channel;
                            if (!this.epgData[channelId]) this.epgData[channelId] = [];
                            this.epgData[channelId].push({
                                start: prog.$.start, // Formato YYYYMMDDhhmmss
                                stop: prog.$.stop,
                                title: prog.title ? (prog.title[0]._ || prog.title[0]) : "Sin título",
                                desc: prog.desc ? (prog.desc[0]._ || prog.desc[0]) : ""
                            });
                        });
                    }
                }
            } catch (e) {
                // Ignoramos errores de EPG para no detener el addon
                console.log(`--> [EPG WARN] Error en guía: ${e.message}`);
            }
        }
        console.log("--> [UPDATE] Finalizado.");
        
        // Actualizar géneros en el manifiesto dinámicamente
        this.updateGenres();
    }

    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        let currentItem = null;

        lines.forEach(line => {
            const l = line.trim();
            if (l.startsWith('#EXTINF:')) {
                // Regex para capturar atributos y nombre
                const info = l.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (info) {
                    const attrs = {};
                    const attrRaw = info[2] || '';
                    // Parsear atributos tipo key="value"
                    const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
                    let m;
                    while ((m = regex.exec(attrRaw)) !== null) attrs[m[1]] = m[2];
                    
                    const fullName = (info[3] || '').trim();

                    currentItem = {
                        name: fullName, // Mantiene el nombre completo "AMC HD --> NEW ERA"
                        logo: attrs['tvg-logo'],
                        tvgId: attrs['tvg-id'] || attrs['tvg-name'],
                        group: attrs['group-title'] || 'OTROS',
                        // ID único basado en el nombre para consistencia
                        id: 'ace_' + crypto.createHash('md5').update(fullName).digest('hex')
                    };
                }
            } else if (l && !l.startsWith('#') && currentItem) {
                currentItem.url = l;
                items.push(currentItem);
                currentItem = null;
            }
        });
        return items;
    }

    updateGenres() {
        // Extrae los group-title únicos
        const groups = [...new Set(this.channels.map(c => c.group))].sort();
        const catalog = manifest.catalogs.find(c => c.id === 'mi_lista');
        if (catalog) catalog.genres = groups;
    }

    // Buscar programa actual según la hora del servidor
    getCurrentProgram(tvgId) {
        if (!tvgId || !this.epgData[tvgId]) return null;
        
        // Hora actual en formato XMLTV (YYYYMMDDhhmmss) aprox
        const now = new Date();
        const y = now.getFullYear();
        const m = (now.getMonth()+1).toString().padStart(2,'0');
        const d = now.getDate().toString().padStart(2,'0');
        const h = now.getHours().toString().padStart(2,'0');
        const mn = now.getMinutes().toString().padStart(2,'0');
        const s = now.getSeconds().toString().padStart(2,'0');
        const nowStr = `${y}${m}${d}${h}${mn}${s}`;

        // Buscar programa que coincida con el rango
        return this.epgData[tvgId].find(p => {
            // Comparación de strings funciona porque el formato es ISO-like
            return p.start <= nowStr && (!p.stop || p.stop > nowStr);
        });
    }
}

const manager = new AceManager();

// --- 3. DEFINICIÓN DEL MANIFIESTO ---
const manifest = {
    id: "org.milista.acestream",
    version: "1.0.1",
    name: "Mi Lista ACE",
    description: "Lista privada desde coincity.tk",
    resources: ["catalog", "meta", "stream"],
    types: ["AceStream"], // TIPO PERSONALIZADO
    catalogs: [
        {
            type: "AceStream",
            id: "mi_lista",
            name: "Mi Lista",
            extra: [{ name: "genre" }, { name: "search" }],
            genres: [] // Se rellena solo
        }
    ],
    idPrefixes: ["ace_"]
};

const builder = new addonBuilder(manifest);

// --- 4. HANDLERS (Respuestas a Stremio) ---

// CARGA DE DATOS INICIAL
// Se ejecuta cuando el servidor arranca
manager.updateData();

builder.defineCatalogHandler(async (args) => {
    // Si la lista está vacía, intentamos cargar (seguridad)
    if (manager.channels.length === 0) await manager.updateData();

    if (args.type === "AceStream" && args.id === "mi_lista") {
        let items = manager.channels;
        
        // Filtros
        if (args.extra && args.extra.genre) {
            items = items.filter(i => i.group === args.extra.genre);
        }
        if (args.extra && args.extra.search) {
            items = items.filter(i => i.name.toLowerCase().includes(args.extra.search.toLowerCase()));
        }

        // Formato ligero para el menú
        const metas = items.map(c => ({
            id: c.id,
            type: "AceStream",
            name: c.name,
            poster: c.logo,
            description: c.group
        }));
        return { metas: metas };
    }
    return { metas: [] };
});

builder.defineMetaHandler(async (args) => {
    // Busca el canal
    const channel = manager.channels.find(c => c.id === args.id);
    if (!channel) return { meta: null };

    // Busca EPG
    const prog = manager.getCurrentProgram(channel.tvgId);
    
    let descriptionText = `Grupo: ${channel.group}`;
    if (prog) {
        descriptionText += `\n\n📺 EN VIVO: ${prog.title}\n${prog.desc}`;
    }

    return {
        meta: {
            id: channel.id,
            type: "AceStream",
            name: channel.name,
            poster: channel.logo,
            background: channel.logo,
            description: descriptionText,
            releaseInfo: "LIVE",
            behaviorHints: { isLive: true }
        }
    };
});

builder.defineStreamHandler(async (args) => {
    const channel = manager.channels.find(c => c.id === args.id);
    if (!channel) return { streams: [] };

    return {
        streams: [{
            url: channel.url,
            title: "Ver en AceStream",
            behaviorHints: { notWebReady: true }
        }]
    };
});

// --- 5. SERVIDOR HTTP (LO IMPORTANTE) ---
// Esto hace que Render pueda ejecutarlo
const addonInterface = builder.getInterface();
serveHTTP(addonInterface, { port: process.env.PORT || 7000 });

// Actualizar lista automáticamente cada 10 hora
setInterval(() => manager.updateData(), 36000 * 1000);
