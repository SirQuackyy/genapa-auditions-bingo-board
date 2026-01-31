const socket = io();

// State
let members = [];
let groups = [];
let gameState = {};
let finalLineup = [];
let currentMember = null;
let currentUser = localStorage.getItem('currentUser'); // Who I actually am
let hasJoined = false;

// DOM Elements
const tabsContainer = document.getElementById('tabs');
const boardContainer = document.getElementById('board-container');
const loginModal = document.getElementById('login-modal');
const memberSelect = document.getElementById('member-select');
const userControls = document.getElementById('user-controls');
const welcomeMsg = document.getElementById('welcome-msg');
const predictionContainer = document.getElementById('prediction-container');
const togglePredictionBtn = document.getElementById('toggle-prediction-btn');

// --- Identity & Init ---

// On Connect: If we know who we are, join immediately. Else show login.
socket.on('connect', () => {
    if (currentUser) {
        joinGame(currentUser);
    } else {
        showLogin();
    }
});

function showLogin() {
    loginModal.style.display = 'flex';
}

function joinGame(name) {
    currentUser = name;
    localStorage.setItem('currentUser', name);
    socket.emit('join', { name: name });
    
    loginModal.style.display = 'none';
    userControls.style.display = 'block';
    welcomeMsg.textContent = `Playing as ${name} `;
    currentMember = name; // View my own board by default
}

function switchUser() {
    localStorage.removeItem('currentUser');
    currentUser = null;
    location.reload();
}

socket.on('init', (data) => {
    console.log('Init data received:', data);
    members = data.members;
    groups = data.groups;
    gameState = data.gameState;
    finalLineup = data.finalLineup;
    
    // Populate Login if needed
    if (!currentUser) {
        memberSelect.innerHTML = '';
        members.forEach(m => {
            const btn = document.createElement('div');
            btn.className = 'member-btn';
            btn.textContent = m;
            btn.onclick = () => joinGame(m);
            memberSelect.appendChild(btn);
        });
    }

    renderTabs();
    renderBoard();
    renderPredictionSection();
});

socket.on('updateState', (data) => {
    const { memberName, selectedIndices, bingoCount } = data;
    if (gameState[memberName]) {
        gameState[memberName].selectedIndices = selectedIndices;
        if (bingoCount !== undefined) gameState[memberName].bingoCount = bingoCount;
        
        if (currentMember === memberName) renderBoard();
        renderTabs();
    }
});

socket.on('bingoAnnouncement', (data) => {
    const { memberName, count } = data;
    showNotification(`🎉 ${memberName} got a BINGO! (Total: ${count}) 🎉`);
});

socket.on('predictionUpdate', (data) => {
    const { memberName, hasPredicted } = data;
    if (gameState[memberName]) {
        if (!gameState[memberName].prediction) gameState[memberName].prediction = {}; 
        gameState[memberName].prediction.hasPredicted = true;
        renderTabs(); 
        
        // If it's me, re-render the prediction section to show the read-only view
        if (memberName === currentUser) {
            // We need the actual prediction data to show the list.
            // The 'predictionUpdate' event only has { hasPredicted: true }.
            // However, since WE just submitted it, we might want to reload or 
            // the server should ideally send back the data or we wait for an init?
            // Actually, for the 'View Only' list, we need the array of strings.
            // The server masks it in 'predictionUpdate' generally? 
            // In app.ts: io.emit('predictionUpdate', { memberName, hasPredicted: true });
            // It does NOT send the prediction array back.
            // So if we just switch to view only, we won't have the list to show 
            // unless we optimistically stored it or fetch it.
            // A simple hack: Reload the page? Or just request init?
            // Or just say "Prediction Submitted" without the list until refresh?
            // Better: update server to send the prediction back to the submitter? 
            // OR, just location.reload() for now to get fresh state?
            location.reload(); 
        }
    }
});


// --- UI Rendering ---

function renderTabs() {
    tabsContainer.innerHTML = '';
    members.forEach(member => {
        const tab = document.createElement('div');
        let classes = `tab ${member === currentMember ? 'active' : ''}`;
        tab.className = classes;
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = member;
        tab.appendChild(nameSpan);

        if (gameState[member] && gameState[member].bingoCount > 0) {
            const badge = document.createElement('div');
            badge.className = 'badge';
            badge.textContent = gameState[member].bingoCount;
            tab.appendChild(badge);
        }

        tab.onclick = () => {
            currentMember = member;
            renderTabs();
            renderBoard();
        };
        tabsContainer.appendChild(tab);
    });
}

function renderBoard() {
    boardContainer.innerHTML = '';
    if (!currentMember || !gameState[currentMember]) return;

    const memberState = gameState[currentMember];
    const board = memberState.board;
    const selectedIndices = memberState.selectedIndices;
    const isMyBoard = (currentMember === currentUser);

    const grid = document.createElement('div');
    grid.className = 'bingo-board';
    // Grey out if not my board
    if (!isMyBoard) {
        grid.style.opacity = '0.7';
    }

    board.forEach((term, index) => {
        const cell = document.createElement('div');
        let cssClass = 'cell';
        if (term === 'FREE SPACE') cssClass += ' free-space';
        if (selectedIndices.includes(index)) cssClass += ' selected';
        cell.className = cssClass;
        cell.textContent = term;
        
        if (isMyBoard) {
            cell.onclick = () => {
                socket.emit('toggleCell', { memberName: currentUser, index: index });
            };
        } else {
            cell.style.cursor = 'default';
        }
        
        grid.appendChild(cell);
    });

    boardContainer.appendChild(grid);
}

// --- Prediction Logic ---
togglePredictionBtn.onclick = () => {
    const isVisible = predictionContainer.classList.contains('visible');
    if (isVisible) {
        predictionContainer.classList.remove('visible');
        togglePredictionBtn.textContent = "Show Lineup Prediction";
    } else {
        predictionContainer.classList.add('visible');
        togglePredictionBtn.textContent = "Hide Lineup Prediction";
    }
};

function renderPredictionSection() {
    if (!currentUser || !gameState[currentUser]) return;

    const myPredictionData = gameState[currentUser].prediction; // { hasPredicted: bool, prediction: [] }
    const hasPredicted = myPredictionData && myPredictionData.hasPredicted;
    
    // 1. Game Over / Leaderboard Mode
    if (finalLineup.length > 0) {
        let html = `<h3>Final Lineup & Results</h3>`;
        html += `<div class="leaderboard">`;
        
        // Calculate scores locally based on public data
        const scores = members.map(m => {
            const data = gameState[m].prediction || {};
            return { name: m, score: data.score || 0 };
        }).sort((a,b) => b.score - a.score);

        scores.forEach(s => {
            html += `<div class="leaderboard-item ${s.score >= 10 ? 'winner' : ''}">
                <span>${s.name}</span>
                <span>${s.score}/12</span>
            </div>`;
        });
        html += `</div>`;
        
        // Show actual lineup
        html += `<h4>Actual Lineup:</h4><ul>` + finalLineup.map(g => `<li>${g}</li>`).join('') + `</ul>`;
        
        predictionContainer.innerHTML = html;
        return;
    }

    // 2. Prediction Submitted Mode
    if (hasPredicted) {
        let html = `<p>✅ You have submitted your prediction.</p>`;
        if (myPredictionData.prediction) {
            html += `<h4>Your Picks:</h4><ul>` + myPredictionData.prediction.map(p => `<li>${p}</li>`).join('') + `</ul>`;
        }
        predictionContainer.innerHTML = html;
        return;
    }

    // 3. Selection Mode
    let html = `<p>Select exactly 12 groups you think will make the lineup.</p>
                <div class="groups-grid">`;
    
    groups.forEach(group => {
        html += `<label class="group-checkbox"><input type="checkbox" value="${group}" class="pred-checkbox"> ${group}</label>`;
    });
    
    html += `</div>
             <p id="count-display">0/12 Selected</p>
             <button id="submit-pred-btn" class="submit-btn" disabled>Submit Final Prediction</button>`;
    
    predictionContainer.innerHTML = html;

    // Logic for checkboxes
    const checkboxes = predictionContainer.querySelectorAll('.pred-checkbox');
    const submitBtn = document.getElementById('submit-pred-btn');
    const countDisplay = document.getElementById('count-display');

    checkboxes.forEach(cb => {
        cb.onchange = () => {
            const selected = Array.from(checkboxes).filter(c => c.checked);
            countDisplay.textContent = `${selected.length}/12 Selected`;
            
            if (selected.length === 12) {
                submitBtn.disabled = false;
                countDisplay.style.color = 'green';
            } else {
                submitBtn.disabled = true;
                countDisplay.style.color = selected.length > 12 ? 'red' : 'black';
            }
        };
    });

    submitBtn.onclick = () => {
        if (!confirm("Are you sure? This cannot be changed.")) return;
        const selected = Array.from(checkboxes).filter(c => c.checked).map(c => c.value);
        socket.emit('submitPrediction', { memberName: currentUser, prediction: selected });
    };
}

// ... (previous code) ...

socket.on('gameOver', (data) => {
    finalLineup = data.finalLineup;
    // Update local state with the revealed predictions/scores
    const publicState = data.gameState;
    Object.keys(publicState).forEach(m => {
        if (gameState[m]) {
             gameState[m].prediction = publicState[m].prediction;
        }
    });
    
    renderPredictionSection();
    // Also hide the admin section if it was visible?
});

// Admin Panel Logic (injected into prediction section for now, or new tab?)
// User asked for "make a tab for this". 
// Let's make a special "Admin" tab in the tabs list? Or just a button?
// A button next to "Show Lineup Prediction" simplifies things.

const adminBtn = document.createElement('button');
adminBtn.className = 'action-btn';
adminBtn.textContent = "Submit Actual Results (Admin)";
adminBtn.style.marginTop = '10px';
adminBtn.style.background = '#d32f2f'; // Red to indicate caution
adminBtn.onclick = showAdminPanel;

document.querySelector('.prediction-section').appendChild(adminBtn);

function showAdminPanel() {
    if (finalLineup.length > 0) {
        alert("Results already submitted!");
        return;
    }
    const adminHtml = `
        <div class="modal-overlay" id="admin-modal">
            <div class="modal" style="max-width: 600px;">
                <h3>Select Final 12 Winners</h3>
                <div class="groups-grid" id="admin-groups-grid"></div>
                <p id="admin-count">0/12 Selected</p>
                <div style="margin-top:20px;">
                    <button class="submit-btn" id="admin-submit-btn" disabled>Confirm & End Game</button>
                    <button class="member-btn" onclick="document.getElementById('admin-modal').remove()">Cancel</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', adminHtml);

    const grid = document.getElementById('admin-groups-grid');
    groups.forEach(group => {
        const label = document.createElement('label');
        label.className = 'group-checkbox';
        label.innerHTML = `<input type="checkbox" value="${group}" class="admin-checkbox"> ${group}`;
        grid.appendChild(label);
    });

    const checkboxes = grid.querySelectorAll('.admin-checkbox');
    const submitBtn = document.getElementById('admin-submit-btn');
    const countDisplay = document.getElementById('admin-count');
    
    checkboxes.forEach(cb => {
        cb.onchange = () => {
            const selected = Array.from(checkboxes).filter(c => c.checked);
            countDisplay.textContent = `${selected.length}/12 Selected`;
            if (selected.length === 12) {
                submitBtn.disabled = false;
            } else {
                submitBtn.disabled = true;
            }
        };
    });

    submitBtn.onclick = () => {
        if (!confirm("This will REVEAL everyone's predictions and show the leaderboard. Cannot be undone.")) return;
        const selected = Array.from(checkboxes).filter(c => c.checked).map(c => c.value);
        socket.emit('submitFinalLineup', { lineup: selected });
        document.getElementById('admin-modal').remove();
    };
}

