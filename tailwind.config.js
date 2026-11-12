// Prebuilt replacement for the Tailwind Play CDN previously loaded in main.html.
// Same config the page used inline (darkMode 'class', preflight OFF, jn colors).
// Rebuild after adding Tailwind classes:  npm run build:css
module.exports = {
    content: ['./main.html', './script.js', './js/**/*.js'],
    darkMode: 'class',
    corePlugins: { preflight: false },
    theme: {
        extend: {
            colors: {
                jn: {
                    green: '#2e7d32',
                    lightGreen: '#4caf50',
                    accentGreen: '#e8f5e9',
                    darkBg: '#0f172a',
                    darkCard: '#1e293b',
                    darkHeader: '#0f172a'
                }
            }
        }
    }
};
