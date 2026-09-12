/* 来源：pi-coding-agent dist/core/export-html/ansi-to-html.js（MIT），改为浏览器全局版 */
(function () {
/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4)
 * - Reset (0)
 */
// Windows Terminal 默认配色（Campbell），比标准 ANSI 暗色在纯黑底上更接近命令行观感
const ANSI_COLORS = [
    "#0c0c0c", // 0: black
    "#c50f1f", // 1: red
    "#13a10e", // 2: green
    "#c19c00", // 3: yellow
    "#0037da", // 4: blue
    "#881798", // 5: magenta
    "#3a96dd", // 6: cyan
    "#cccccc", // 7: white
    "#767676", // 8: bright black
    "#e74856", // 9: bright red
    "#16c60c", // 10: bright green
    "#f9f1a5", // 11: bright yellow
    "#3b78ff", // 12: bright blue
    "#b4009e", // 13: bright magenta
    "#61d6d6", // 14: bright cyan
    "#f2f2f2", // 15: bright white
];
/**
 * Convert 256-color index to hex.
 */
function color256ToHex(index) {
    // Standard colors (0-15)
    if (index < 16) {
        return ANSI_COLORS[index];
    }
    // Color cube (16-231): 6x6x6 = 216 colors
    if (index < 232) {
        const cubeIndex = index - 16;
        const r = Math.floor(cubeIndex / 36);
        const g = Math.floor((cubeIndex % 36) / 6);
        const b = cubeIndex % 6;
        const toComponent = (n) => (n === 0 ? 0 : 55 + n * 40);
        const toHex = (n) => toComponent(n).toString(16).padStart(2, "0");
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
    // Grayscale (232-255): 24 shades
    const gray = 8 + (index - 232) * 10;
    const grayHex = gray.toString(16).padStart(2, "0");
    return `#${grayHex}${grayHex}${grayHex}`;
}
/**
 * Escape HTML special characters.
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
function createEmptyStyle() {
    return {
        fg: null,
        bg: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
    };
}
function styleToInlineCSS(style) {
    const parts = [];
    if (style.fg)
        parts.push(`color:${style.fg}`);
    if (style.bg)
        parts.push(`background-color:${style.bg}`);
    if (style.bold)
        parts.push("font-weight:bold");
    if (style.dim)
        parts.push("opacity:0.6");
    if (style.italic)
        parts.push("font-style:italic");
    if (style.underline)
        parts.push("text-decoration:underline");
    return parts.join(";");
}
function hasStyle(style) {
    return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}
/**
 * Parse ANSI SGR (Select Graphic Rendition) codes and update style.
 */
function applySgrCode(params, style) {
    let i = 0;
    while (i < params.length) {
        const code = params[i];
        if (code === 0) {
            // Reset all
            style.fg = null;
            style.bg = null;
            style.bold = false;
            style.dim = false;
            style.italic = false;
            style.underline = false;
        }
        else if (code === 1) {
            style.bold = true;
        }
        else if (code === 2) {
            style.dim = true;
        }
        else if (code === 3) {
            style.italic = true;
        }
        else if (code === 4) {
            style.underline = true;
        }
        else if (code === 22) {
            // Reset bold/dim
            style.bold = false;
            style.dim = false;
        }
        else if (code === 23) {
            style.italic = false;
        }
        else if (code === 24) {
            style.underline = false;
        }
        else if (code >= 30 && code <= 37) {
            // Standard foreground colors
            style.fg = ANSI_COLORS[code - 30];
        }
        else if (code === 38) {
            // Extended foreground color
            if (params[i + 1] === 5 && params.length > i + 2) {
                // 256-color: 38;5;N
                style.fg = color256ToHex(params[i + 2]);
                i += 2;
            }
            else if (params[i + 1] === 2 && params.length > i + 4) {
                // RGB: 38;2;R;G;B
                const r = params[i + 2];
                const g = params[i + 3];
                const b = params[i + 4];
                style.fg = `rgb(${r},${g},${b})`;
                i += 4;
            }
        }
        else if (code === 39) {
            // Default foreground
            style.fg = null;
        }
        else if (code >= 40 && code <= 47) {
            // Standard background colors
            style.bg = ANSI_COLORS[code - 40];
        }
        else if (code === 48) {
            // Extended background color
            if (params[i + 1] === 5 && params.length > i + 2) {
                // 256-color: 48;5;N
                style.bg = color256ToHex(params[i + 2]);
                i += 2;
            }
            else if (params[i + 1] === 2 && params.length > i + 4) {
                // RGB: 48;2;R;G;B
                const r = params[i + 2];
                const g = params[i + 3];
                const b = params[i + 4];
                style.bg = `rgb(${r},${g},${b})`;
                i += 4;
            }
        }
        else if (code === 49) {
            // Default background
            style.bg = null;
        }
        else if (code >= 90 && code <= 97) {
            // Bright foreground colors
            style.fg = ANSI_COLORS[code - 90 + 8];
        }
        else if (code >= 100 && code <= 107) {
            // Bright background colors
            style.bg = ANSI_COLORS[code - 100 + 8];
        }
        // Ignore unrecognized codes
        i++;
    }
}
// Match ANSI escape sequences: ESC[ followed by params and ending with 'm'
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;
/**
 * Convert ANSI-escaped text to HTML with inline styles.
 */
function ansiToHtml(text) {
    const style = createEmptyStyle();
    let result = "";
    let lastIndex = 0;
    let inSpan = false;
    // Reset regex state
    ANSI_REGEX.lastIndex = 0;
    let match = ANSI_REGEX.exec(text);
    while (match !== null) {
        // Add text before this escape sequence
        const beforeText = text.slice(lastIndex, match.index);
        if (beforeText) {
            result += escapeHtml(beforeText);
        }
        // Parse SGR parameters
        const paramStr = match[1];
        const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];
        // Close existing span if we have one
        if (inSpan) {
            result += "</span>";
            inSpan = false;
        }
        // Apply the codes
        applySgrCode(params, style);
        // Open new span if we have any styling
        if (hasStyle(style)) {
            result += `<span style="${styleToInlineCSS(style)}">`;
            inSpan = true;
        }
        lastIndex = match.index + match[0].length;
        match = ANSI_REGEX.exec(text);
    }
    // Add remaining text
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
        result += escapeHtml(remainingText);
    }
    // Close any open span
    if (inSpan) {
        result += "</span>";
    }
    return result;
}
/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 */
function ansiLinesToHtml(lines) {
    return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
window.ansiToHtml = ansiToHtml;
// 注：ansiLinesToHtml 是本项目从 pi 移植时一并带来的，实际未使用，故不再导出
})();
