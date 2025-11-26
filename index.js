const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require('node-fetch');
const crypto = require("crypto");

// --- 1. CONFIGURACIÓN ---
const CONFIG = {
    m3uUrl: "http://coincity.tk/f/acem3u.m3u",
    // Logo genérico para canales sin imagen (Esencial para que Stremio no los oculte)
    defaultLogo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Blue_question_mark_icon.svg/1024px-Blue_question_mark_icon.svg.png"
};

// --- 2. GESTOR DE DATOS ---
class AceManager {
    constructor() {
        this.channels = [];
    }

    async updateData() {
        console.log("--> [UPDATE] Descargando lista...");
        try {
            const res = await fetch(CONFIG.m3uUrl);
            if(res.ok) {
                const text = await res.text();
                this.channels = this.parseM3U(text);
                console.log(`--> [LISTA] Éxito: ${this.channels.length} canales cargados.`);
            } else {
                console.log(`--> [ERROR] Estado HTTP: ${res.status}`);
            }
        } catch (e) {
            console.log("--> [ERROR] Red:", e.message);
        }
    }

    parseM3U(content) {
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
                    
                    const fullName = (info[3] || '').trim();
                    const group = attrs['group-title'] || 'OTROS';
                    
                    // Limpieza de logo: Si está vacío, es null
                    let logo = attrs['tvg-logo'];
                    if (logo && logo.trim() === "") logo = null;

                    currentItem = {
                        name: fullName,
                        logo: logo, 
                        group: group,
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

    getGenres() {
        const groups = new Set(this.channels.map(c => c.group));
        return [...groups].sort();
    }
}

// --- 3. ARRANQUE ---
async function startAddon() {
    const manager = new AceManager();
    await manager.updateData();
    
    const rawGenres = manager.getGenres();
    const dynamicGenres = ["TODOS", ...rawGenres];
    
    console.log(`--> [GÉNEROS] ${dynamicGenres.length} categorías listas.`);

    // --- MANIFIESTO ---
    const manifest = {
        // Subimos versión para asegurar refresco
        id: "org.milista.final.v5", 
        version: "5.0.0", 
        name: "Mi Lista ACE (v5)",
        description: "Lista con Logos Default",
        resources: ["catalog", "meta", "stream"],
        types: ["AceStream"],
        catalogs: [
            {
                type: "AceStream",
                id: "mi_lista",
                name: "Mi Lista",
                extra: [
                    { name: "genre", isRequired: false, options: dynamicGenres }, 
                    { name: "search" },
                    { name: "skip" }
                ],
                genres: dynamicGenres
            }
        ],
        idPrefixes: ["ace_"]
    };

    const builder = new addonBuilder(manifest);

    // HANDLER CATÁLOGO (EL QUE FALLABA)
    builder.defineCatalogHandler((args) => {
        console.log(`--> [SOLICITUD] Catálogo: ${args.id} | Género: ${args.extra?.genre || 'Ninguno'}`);

        if (args.type === "AceStream" && args.id === "mi_lista") {
            let items = manager.channels;
            
            // Filtro Género
            if (args.extra && args.extra.genre && args.extra.genre !== "TODOS") {
                items = items.filter(i => i.group === args.extra.genre);
            }
            
            // Filtro Búsqueda
            if (args.extra && args.extra.search) {
                items = items.filter(i => i.name.toLowerCase().includes(args.extra.search.toLowerCase()));
            }

            // Mapeo con LOGO POR DEFECTO
            const metas = items.map(c => ({
                id: c.id,
                type: "AceStream",
                name: c.name,
                // Si no hay logo, usa el genérico. Si no, Stremio lo oculta.
                poster: c.logo || CONFIG.defaultLogo,
                description: c.group
            }));

            console.log(`--> [RESPUESTA] Enviando ${metas.length} items.`);
            return Promise.resolve({ metas: metas });
        }
        return Promise.resolve({ metas: [] });
    });

    builder.defineMetaHandler((args) => {
        const channel = manager.channels.find(c => c.id === args.id);
        if (!channel) return Promise.resolve({ meta: null });

        const finalLogo = channel.logo || CONFIG.defaultLogo;

        return Promise.resolve({
            meta: {
                id: channel.id,
                type: "AceStream",
                name: channel.name,
                poster: finalLogo,
                background: finalLogo,
                description: `Grupo: ${channel.group}`,
                releaseInfo: "LIVE",
                behaviorHints: { isLive: true }
            }
        });
    });

    builder.defineStreamHandler((args) => {
        const channel = manager.channels.find(c => c.id === args.id);
        if (!channel) return Promise.resolve({ streams: [] });

        return Promise.resolve({
            streams: [{
                url: channel.url,
                title: "Ver en AceStream",
                behaviorHints: { notWebReady: true }
            }]
        });
    });

    const addonInterface = builder.getInterface();
    serveHTTP(addonInterface, { port: process.env.PORT || 7000 });
    
    console.log("--> [SERVIDOR] Online v5.");
    setInterval(() => manager.updateData(), 36000 * 1000);
}

startAddon();
