module.exports = {
    // Sovereign Infrastructure Config

    // Array of host:port strings for private RF-based VPS fleet
    BOOTSTRAP_NODES: [
        { host: '195.201.148.171', port: 49737, publicKey: '535c2283731986026127f7a9f220e2606779fbaf99bc2ceb869bcdc1b00245e8' },
        { host: '89.23.113.35', port: 49737, publicKey: 'd29747a47fd8a67bcebdd2b0c6668700f41eb4ff809676346551e17512642439' },
        // Public Fallback (if private swarm fails) - HyperDHT Default
        { host: 'node1.hyperdht.org', port: 49737 },
        { host: 'node2.hyperdht.org', port: 49737 },
        { host: 'node3.hyperdht.org', port: 49737 }
    ],
    BOOTSTRAP_URL: 'https://f-launcher.ru/fox/new/bootstrap.json',
    P2P_KILL_SWITCH_URL: 'https://f-launcher.ru/fox/new/p2poff.json',
    SUPPORT_CONFIG_URL: 'https://f-launcher.ru/fox/new/support.json',

    // Optional: Array of mirror base URLs for Mojang assets
    // If primary fails, these will be tried in order.
    MOJANG_MIRRORS: [
        {
            "name": "Fox 1 Mirror",
            "assets": "https://f-launcher.ru/fox/new/mirror/assets/objects",
            "libraries": "https://f-launcher.ru/fox/new/mirror/libraries",
            "client": "https://f-launcher.ru/fox/new/mirror/client",
            "version_manifest": "https://f-launcher.ru/fox/new/mirror/metadata/version_manifest_v2.json",
            "piston_meta": "https://f-launcher.ru/fox/new/mirror/metadata",
            "launcher_meta": "https://f-launcher.ru/fox/new/mirror/metadata",
            "java_manifest": "https://f-launcher.ru/fox/new/mirror/java/manifest.json",
            "distribution": "https://f-launcher.ru/fox/new/distribution.json"
        },
        {
            "name": "Ext 1 Mirror",
            "assets": "https://mirror.nikita.best/mirror/assets/objects",
            "libraries": "https://mirror.nikita.best/mirror/libraries",
            "client": "https://mirror.nikita.best/mirror/client",
            "version_manifest": "https://mirror.nikita.best/mirror/metadata/version_manifest_v2.json",
            "piston_meta": "https://mirror.nikita.best/mirror/metadata",
            "launcher_meta": "https://mirror.nikita.best/mirror/metadata",
            "java_manifest": "https://mirror.nikita.best/java/manifest.json",
            "distribution": "https://mirror.nikita.best/distribution.json"
        },
        {
            "name": "Ext CloudFlare CDN",
            "assets": "https://cdn-fox.envel.top/mirror/assets/objects",
            "libraries": "https://cdn-fox.envel.top/mirror/libraries",
            "client": "https://cdn-fox.envel.top/mirror/client",
            "version_manifest": "https://cdn-fox.envel.top/mirror/metadata/version_manifest_v2.json",
            "piston_meta": "https://cdn-fox.envel.top/mirror/metadata",
            "launcher_meta": "https://cdn-fox.envel.top/mirror/metadata",
            "java_manifest": "https://cdn-fox.envel.top/java/manifest.json",
            "distribution": "https://cdn-fox.envel.top/distribution.json"
        }
        // {
        //     name: "Example Mirror",
        //     assets: "https://mirror.example.com/assets/objects", // Replaces resources.download.minecraft.net
        //     libraries: "https://mirror.example.com/libraries", // Replaces libraries.minecraft.net
        //     client: "https://mirror.example.com/client", // Replaces piston-data.mojang.com for client jar
        //     version_manifest: "https://mirror.example.com/mc/game/version_manifest_v2.json", // Replaces piston-meta.mojang.com
        //     piston_meta: "https://mirror.example.com/metadata", // Optional: Replaces piston-meta.mojang.com (extracted from version_manifest if missing)
        //     launcher_meta: "https://mirror.example.com/launchermeta" // Replaces launchermeta.mojang.com
        // }
    ],

    // Ed25519 Distribution Signatures
    // Tuple of trusted public keys (hex strings)
    DISTRO_PUB_KEYS: [
        '47719aff1f56160e4d07d6e35add3f31e1e96c918cc24e37fc569a9a99cc190f'
    ],



    // Discovery settings
    DISCOVERY: {
        MDNS: true,      // Crucial for zero-latency LAN P2P
        DHT: true,       // Enable Distributed Hash Table
        PUBLIC_DHT: true // Attempt to use public DHT if private fails
    },

    // P2P Protocol Constants
    PROTOCOL: {
        VERSION: 1,
        TIMEOUT: 30000,   // 30s timeout (was 20s) - Increased for slow/global connections
        MAX_RETRIES: 3
    }
}
