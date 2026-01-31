import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = 3000;

// --- Data Loading ---
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');
const MEMBERS_FILE = path.join(ROOT_DIR, 'members.txt');
const TERMS_FILE = path.join(ROOT_DIR, 'bingo_terms.txt');
const GROUPS_FILE = path.join(ROOT_DIR, 'groups.txt');
const LINEUP_FILE = path.join(ROOT_DIR, 'final_lineup.txt');

function loadFile(filePath: string): string[] {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
        return [];
    }
}

const members = loadFile(MEMBERS_FILE);
const terms = loadFile(TERMS_FILE);
const groups = loadFile(GROUPS_FILE);
let finalLineup: string[] = [];
if (fs.existsSync(LINEUP_FILE)) {
    finalLineup = loadFile(LINEUP_FILE);
}

console.log(`Loaded ${members.length} members, ${terms.length} terms, ${groups.length} groups.`);

if (terms.length < 24) {
    console.warn("WARNING: Fewer than 24 terms loaded. Boards may have duplicates or be incomplete.");
}

// --- Game State ---
interface BoardState {
    board: string[];
    selectedIndices: number[];
    prediction: string[] | null;
}

// Map<MemberName, BoardState>
const gameState: Record<string, BoardState> = {};

function generateBoard(terms: string[]): string[] {
    // Basic shuffle
    const shuffled = [...terms].sort(() => 0.5 - Math.random());
    // Take first 24
    const board = shuffled.slice(0, 24);
    // Insert Free Space
    board.insert(12, "FREE SPACE"); // Custom helper or logic below
    return board;
}

// Helper for insert since Array.prototype.insert is not standard in TS without polyfill
Array.prototype.insert = function (index: number, item: any) {
    this.splice(index, 0, item);
};

declare global {
    interface Array<T> {
        insert(index: number, item: T): void;
    }
}

// Initialize Game State
// --- Persistence ---
const DATA_FILE = path.join(ROOT_DIR, 'gamestate.json');

function loadGameState(): Record<string, BoardState> {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = fs.readFileSync(DATA_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("Error loading game state:", error);
    }
    return {};
}

function saveGameState() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(gameState, null, 2));
    } catch (error) {
        console.error("Error saving game state:", error);
    }
}

// Initialize Game State
// 1. Load existing state
const loadedState = loadGameState();

// 2. Ensure all current members have a board
members.forEach(member => {
    if (loadedState[member]) {
        // Reuse existing board and state
        gameState[member] = loadedState[member];
        if (!gameState[member].prediction) {
            gameState[member].prediction = null;
        }
    } else {
        // New member: Generate new board
        let currentTerms = [...terms];
        const boardTerms: string[] = [];

        if (currentTerms.length >= 24) {
            // Fisher-Yates shuffle
            for (let i = currentTerms.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [currentTerms[i], currentTerms[j]] = [currentTerms[j], currentTerms[i]];
            }
            boardTerms.push(...currentTerms.slice(0, 24));
        } else {
            boardTerms.push(...currentTerms);
        }

        // Insert Free Space
        if (boardTerms.length >= 12) {
            boardTerms.splice(12, 0, "FREE SPACE");
        } else {
            boardTerms.push("FREE SPACE");
        }

        gameState[member] = {
            board: boardTerms,
            selectedIndices: [],
            prediction: null
        };
    }
});

// 3. Save state immediately to sync any new members or cleanup
saveGameState();

// --- Express Setup ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Bingo Logic ---
function calculateBingoCount(selected: number[]): number {
    // 5x5 Grid
    // Rows: 0-4, 5-9, ...
    // Cols: 0,5,10..., 1,6,11...
    // Diagonals: 0,6,12,18,24 and 4,8,12,16,20

    // Always include free space (12)
    const effectiveSelected = new Set(selected);
    effectiveSelected.add(12);

    let count = 0;

    // Rows
    for (let r = 0; r < 5; r++) {
        let full = true;
        for (let c = 0; c < 5; c++) {
            if (!effectiveSelected.has(r * 5 + c)) {
                full = false;
                break;
            }
        }
        if (full) count++;
    }

    // Cols
    for (let c = 0; c < 5; c++) {
        let full = true;
        for (let r = 0; r < 5; r++) {
            if (!effectiveSelected.has(r * 5 + c)) {
                full = false;
                break;
            }
        }
        if (full) count++;
    }

    // Diagonal 1 (TL-BR)
    let d1 = true;
    for (let i = 0; i < 5; i++) {
        if (!effectiveSelected.has(i * 6)) {
            d1 = false;
            break;
        }
    }
    if (d1) count++;

    // Diagonal 2 (TR-BL)
    let d2 = true;
    for (let i = 0; i < 5; i++) {
        if (!effectiveSelected.has((i + 1) * 4)) {
            d2 = false;
            break;
        }
    }
    if (d2) count++;

    return count;
}


// --- Socket.io Setup ---
io.on('connection', (socket) => {
    console.log('A user connected');

    // Helper to augment state with counts AND mask predictions
    const getPublicState = (requestingUser?: string) => {
        const publicState: Record<string, any> = {};
        for (const [member, state] of Object.entries(gameState)) {
            let predictionData: any = { hasPredicted: !!state.prediction };

            // Only show actual prediction if it's their own or if final lineup exists (game over)
            if (finalLineup.length > 0) {
                // Game over: Calculate score
                let score = 0;
                if (state.prediction) {
                    score = state.prediction.filter(p => finalLineup.includes(p)).length;
                }
                predictionData = {
                    hasPredicted: !!state.prediction,
                    prediction: state.prediction,
                    score: score
                };
            } else if (member === requestingUser && state.prediction) {
                // Show my own
                predictionData = {
                    hasPredicted: true,
                    prediction: state.prediction
                };
            }

            publicState[member] = {
                ...state,
                bingoCount: calculateBingoCount(state.selectedIndices),
                prediction: predictionData // Masked or partial
            };
        }
        return publicState;
    };

    // New init: Client sends their identity to get their private data
    socket.on('join', (data: { name: string }) => {
        socket.emit('init', {
            members: members,
            groups: groups,
            gameState: getPublicState(data.name),
            finalLineup: finalLineup
        });
    });

    // Fallback for old clients or initial connect without name
    socket.emit('init', {
        members: members,
        groups: groups,
        gameState: getPublicState(),
        finalLineup: finalLineup
    });

    socket.on('submitPrediction', (data: { memberName: string, prediction: string[] }) => {
        const { memberName, prediction } = data;

        // Validation: Only update if not already set (unless we want to allow editing? User said "ONLY ONE TIME")
        if (gameState[memberName] && !gameState[memberName].prediction) {
            if (prediction.length === 12) {
                gameState[memberName].prediction = prediction;
                saveGameState();

                // Broadcast update (masked) - just say "he predicted"
                io.emit('predictionUpdate', {
                    memberName: memberName,
                    hasPredicted: true
                });
            }
        }
    });

    socket.on('submitFinalLineup', (data: { lineup: string[] }) => {
        if (data.lineup && data.lineup.length > 0) {
            finalLineup = data.lineup;
            try {
                fs.writeFileSync(LINEUP_FILE, finalLineup.join('\n'));
            } catch (e) { console.error("Error saving lineup:", e); }

            // Broadcast game over state to everyone
            io.emit('gameOver', {
                finalLineup: finalLineup,
                gameState: getPublicState() // Now containing scores/revealed predictions
            });
        }
    });

    socket.on('toggleCell', (data: { memberName: string, index: number }) => {
        const { memberName, index } = data;
        const memberState = gameState[memberName];

        if (memberState) {
            const oldBingoCount = calculateBingoCount(memberState.selectedIndices);

            const selectedIdx = memberState.selectedIndices.indexOf(index);
            if (selectedIdx > -1) {
                // Deselect
                memberState.selectedIndices.splice(selectedIdx, 1);
            } else {
                // Select
                memberState.selectedIndices.push(index);
            }

            const newBingoCount = calculateBingoCount(memberState.selectedIndices);

            // Broadcast update
            io.emit('updateState', {
                memberName: memberName,
                selectedIndices: memberState.selectedIndices,
                bingoCount: newBingoCount
            });

            // Check for NEW bingo
            if (newBingoCount > oldBingoCount) {
                io.emit('bingoAnnouncement', {
                    memberName: memberName,
                    count: newBingoCount
                });
            }

            // Save changes to disk
            saveGameState();
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
