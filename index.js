// index.js
require('dotenv').config({ path: 'atlas-credentials.env' });

const WebSocket = require('ws');
const { Meld, valueForRank } = require('./meld');
const db = require('./db');
const { signToken, verifyToken } = require('./auth');
console.log(process.env.MONGODB_URI);

const PORT = process.env.PORT || 8080;
const MAX_HAND_SIZE = 15;
const SNATCH_WINDOW_MS = 2000;
const SNATCH_PENALTY = 3;

const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateRoomId(len = 6) {
    let s = '';
    for (let i = 0; i < len; i++) {
        s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    }
    return s;
}

function newCard(rank, suit) { return { rank, suit, joker: false }; }
function newJoker() { return { rank: 0, suit: null, joker: true }; }

function buildDeck(cardSets, jokersPerSet) {
    const sets = Math.max(1, cardSets | 0);
    const jokers = Math.max(0, jokersPerSet | 0);
    const deck = [];
    for (let d = 0; d < sets; d++) {
        for (let s = 0; s < 4; s++) {
            for (let r = 1; r <= 13; r++) deck.push(newCard(r, s));
        }
        for (let j = 0; j < jokers; j++) deck.push(newJoker());
    }
    return deck;
}
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}
function normalizeRank(r) { return r === 14 ? 1 : r; }
function cardsEqual(a, b) {
    if (!a || !b) return false;
    if (a.joker || b.joker) return !!a.joker && !!b.joker;
    return normalizeRank(a.rank) === normalizeRank(b.rank) && a.suit === b.suit;
}
function cardKey(c) {
    if (!c) return '';
    if (c.joker) return 'J';
    return `r${normalizeRank(c.rank)}s${c.suit}`;
}

function defaultConfig() {
    return {
        playerCount: 4, teamsMode: false, mode: 'hareeg', difficulty: 'easy',
        elimination: 31, minMeld: 51, cardSets: 2, jokersPerSet: 2,
        fixedMeld: false, penalties: false,
    };
}
function normalizeConfig(c) {
    const d = defaultConfig();
    if (!c || typeof c !== 'object') return d;
    const n = { ...d, ...c };
    if (n.playerCount < 2 || n.playerCount > 4) n.playerCount = 4;
    if (n.cardSets < 1) n.cardSets = 2;
    if (n.jokersPerSet < 0) n.jokersPerSet = 2;
    if (n.elimination < 5) n.elimination = 31;
    if (n.minMeld < 0) n.minMeld = 51;
    return n;
}

// ═══════════════════════════════════════════════════════════════════
// ROOM
// ═══════════════════════════════════════════════════════════════════
class Room {
    constructor(id, name, hostName, config) {
        this.id = id;
        this.name = name;
        this.hostName = hostName;
        this.config = normalizeConfig(config);
        this.phase = 'lobby';
        this.clients = [];

        this.hands = [];
        this.scores = [];
        this.previousScores = [];
        this.foulsThisRound = [];
        this.eliminated = [];
        this.hasMeldedArr = [];
        this.bannedCovers = [];

        this.deck = [];
        this.discard = [];
        this.currentSeat = 0;
        this.turnPhase = 'draw';
        this.melds = [];
        this._meldsId = 1;

        this.firstMeldMade = false;
        this.initialMeldTarget = 0;
        this.thresholdOwner = null;
        this.thresholdOwnerTotal = 0;

        this.meldsThisTurn = [];
        this.coversThisTurnValue = 0;

        this.lastDiscardAt = 0;
        this.lastDiscardSeat = -1;
        this.lastDiscardSnatched = false;
        this.snatchedCards = [];
        this.snatchRetries = [];

        this.currentRound = 1;
        this._roundTimer = null;
    }

    capacity() { return this.config.playerCount; }
    isFull() { return this.clients.length >= this.capacity(); }
    broadcast(o) { for (const c of this.clients) c.send(o); }
    playerInfos() { return this.clients.map((c, i) => ({ seat: i, name: c.name })); }

    broadcastLobby() {
        this.broadcast({
            type: 'room_update', room: this.name, roomId: this.id,
            phase: this.phase, host: this.hostName,
            capacity: this.capacity(),
            players: this.playerInfos(), config: this.config,
        });
    }

    currentScores() {
        const out = [];
        for (let i = 0; i < this.clients.length; i++) {
            out.push(this.previousScores[i] + this.foulsThisRound[i]);
        }
        return out;
    }

    _randomActivePlayer() {
        const active = [];
        for (let i = 0; i < this.clients.length; i++) {
            if (!this.eliminated[i]) active.push(i);
        }
        if (!active.length) return 0;
        return active[Math.floor(Math.random() * active.length)];
    }

    _addFoul(seat, reason) {
        this.foulsThisRound[seat] += 3;
        this.clients[seat].send({ type: 'error', message: reason + ' +3' });
        const total = this.previousScores[seat] + this.foulsThisRound[seat];
        if (!this.eliminated[seat] && total >= this.config.elimination) {
            this.eliminated[seat] = true;
            this.clients[seat].send({
                type: 'error',
                message: this.clients[seat].name + ' was eliminated!',
            });
        }
    }

    meldsThisTurnValue() {
        let s = 0;
        const ids = new Set(this.meldsThisTurn);
        for (const m of this.melds) {
            if (ids.has(m.id)) s += m.meld.lockedValue ?? m.meld.totalValue;
        }
        return s;
    }

    openThreshold() {
        return this.firstMeldMade ? this.initialMeldTarget : this.config.minMeld;
    }

    updateThreshold(playerIndex, turnAdded) {
        if (!this.firstMeldMade) {
            this.initialMeldTarget = turnAdded;
            this.firstMeldMade = true;
            this.thresholdOwner = playerIndex;
            this.thresholdOwnerTotal = turnAdded;
            return;
        }
        if (this.thresholdOwner !== playerIndex) return;
        this.thresholdOwnerTotal += turnAdded;
        if (this.thresholdOwnerTotal > this.initialMeldTarget) {
            this.initialMeldTarget = this.thresholdOwnerTotal;
        }
    }

    sendStateTo(seat) {
        if (seat < 0 || seat >= this.clients.length) return;
        const counts = this.clients.map((_, i) => i === seat ? 0 : this.hands[i].length);
        const meldsJson = this.melds.map((m) => ({
            id: m.id, owner: m.owner, type: m.meld.type,
            cards: m.meld.cards,
            jokerRanks: m.meld.jokerRanks,
            jokerSuits: m.meld.jokerSuits,
            lockedValue: m.meld.lockedValue ?? m.meld.totalValue,
        }));

        const discardTail = this.discard.slice(-6);
        const bannedForSeat = Array.from(this.bannedCovers[seat] || []);
        const st = this.snatchedCards[seat];
        const snatchedCard = st ? {
            card: st.card, isSnatch: st.isSnatch, melded: st.melded,
        } : null;

        this.clients[seat].send({
            type: 'state', room: this.name, roomId: this.id, phase: this.phase,
            you: seat, players: this.playerInfos(),
            hand: this.hands[seat] || [],
            opponentCounts: counts,
            deckSize: this.deck.length,
            discardTop: discardTail.length ? discardTail[discardTail.length - 1] : null,
            discardStack: discardTail,
            discardCount: this.discard.length,
            currentSeat: this.currentSeat,
            turnPhase: this.turnPhase,
            config: this.config,
            melds: meldsJson,
            meldsThisTurn: this.meldsThisTurn.slice(),
            hasMeldedThisRound: this.hasMeldedArr.slice(),
            openThreshold: this.openThreshold(),
            scores: this.currentScores(),
            eliminated: this.eliminated.slice(),
            fouls: this.foulsThisRound.slice(),
            currentRound: this.currentRound,
            bannedCovers: bannedForSeat,
            meldsThisTurnValue: this.meldsThisTurnValue(),
            coversThisTurnValue: this.coversThisTurnValue,
            lastDiscardSeat: this.lastDiscardSeat,
            lastDiscardAt: this.lastDiscardAt,
            lastDiscardSnatched: this.lastDiscardSnatched,
            snatchedCard: snatchedCard,
            snatchRetry: this.snatchRetries[seat] === true,
        });
    }

    startGame(hostClient) {
        if (this.phase !== 'lobby') return;
        if (this.clients[0] !== hostClient) {
            hostClient.send({ type: 'error', message: 'Only the host can start' });
            return;
        }
        if (this.clients.length < 2) {
            hostClient.send({ type: 'error', message: 'Need at least 2 players' });
            return;
        }

        const n = this.clients.length;
        this.scores = Array(n).fill(0);
        this.previousScores = Array(n).fill(0);
        this.foulsThisRound = Array(n).fill(0);
        this.eliminated = Array(n).fill(false);
        this.hasMeldedArr = Array(n).fill(false);
        this.bannedCovers = Array.from({ length: n }, () => new Set());
        this.snatchedCards = Array(n).fill(null);
        this.snatchRetries = Array(n).fill(false);

        this.currentRound = 1;
        this.currentSeat = this._randomActivePlayer();
        this.phase = 'playing';
        this._dealNewRound();
    }

    _dealNewRound() {
        const n = this.clients.length;
        this.deck = buildDeck(this.config.cardSets, this.config.jokersPerSet);
        shuffle(this.deck);

        this.hands = Array.from({ length: n }, () => []);
        for (let r = 0; r < 14; r++) {
            for (let p = 0; p < n; p++) {
                if (!this.eliminated[p] && this.deck.length) {
                    this.hands[p].push(this.deck.pop());
                }
            }
        }

        this.discard = [];
        this.melds = [];
        this._meldsId = 1;
        this.meldsThisTurn = [];
        this.coversThisTurnValue = 0;
        this.firstMeldMade = false;
        this.initialMeldTarget = 0;
        this.thresholdOwner = null;
        this.thresholdOwnerTotal = 0;
        this.turnPhase = 'draw';

        this.lastDiscardAt = 0;
        this.lastDiscardSeat = -1;
        this.lastDiscardSnatched = false;
        this.snatchedCards = Array(n).fill(null);
        this.snatchRetries = Array(n).fill(false);

        for (let i = 0; i < n; i++) {
            if (!this.eliminated[i]) {
                this.hasMeldedArr[i] = false;
                this.bannedCovers[i] = new Set();
            }
        }

        this.phase = 'playing';
        for (let p = 0; p < n; p++) this.sendStateTo(p);
    }

    _checkRoundEnd() {
        if (this.phase !== 'playing') return;
        for (let i = 0; i < this.clients.length; i++) {
            if (!this.eliminated[i] && this.hands[i].length === 0) {
                const st = this.snatchedCards[i];
                if (st && st.isSnatch && st.melded &&
                    st.discarder >= 0 && st.discarder !== i) {
                    this.previousScores[i] -= SNATCH_PENALTY;
                    this.previousScores[st.discarder] += SNATCH_PENALTY;
                    const discTotal = this.previousScores[st.discarder] +
                        this.foulsThisRound[st.discarder];
                    if (!this.eliminated[st.discarder] &&
                        discTotal >= this.config.elimination) {
                        this.eliminated[st.discarder] = true;
                    }
                }
                this.snatchedCards[i] = null;
                this.snatchRetries[i] = false;
                this._endRound(false, i);
                return;
            }
        }
    }

    _endRound(byDeckEmpty, winnerIndex) {
        if (this.phase !== 'playing') return;
        this.phase = 'roundEnd';

        for (let i = 0; i < this.clients.length; i++) {
            this.scores[i] = this.previousScores[i] +
                this.hands[i].length + this.foulsThisRound[i];
        }

        for (let i = 0; i < this.clients.length; i++) {
            if (!this.eliminated[i] && this.scores[i] >= this.config.elimination) {
                this.eliminated[i] = true;
            }
        }

        let nextStarter;
        if (byDeckEmpty || winnerIndex == null || this.eliminated[winnerIndex]) {
            nextStarter = this._randomActivePlayer();
        } else {
            nextStarter = winnerIndex;
        }

        const winnerName = byDeckEmpty ? 'Deck empty'
            : (winnerIndex >= 0 ? this.clients[winnerIndex].name : '');
        const activeCount = this.eliminated.filter((e) => !e).length;

        for (let i = 0; i < this.clients.length; i++) {
            this.clients[i].send({
                type: 'state', room: this.name, roomId: this.id, phase: this.phase,
                you: i, players: this.playerInfos(),
                hand: this.hands[i] || [],
                opponentCounts: this.clients.map((_, j) => j === i ? 0 : this.hands[j].length),
                deckSize: this.deck.length,
                discardTop: this.discard.length ? this.discard[this.discard.length - 1] : null,
                discardStack: this.discard.slice(-6),
                discardCount: this.discard.length,
                currentSeat: this.currentSeat, turnPhase: this.turnPhase,
                config: this.config, melds: [], meldsThisTurn: [],
                hasMeldedThisRound: this.hasMeldedArr.slice(),
                openThreshold: this.openThreshold(),
                scores: this.scores.slice(),
                eliminated: this.eliminated.slice(),
                fouls: this.foulsThisRound.slice(),
                currentRound: this.currentRound,
                bannedCovers: [], meldsThisTurnValue: 0, coversThisTurnValue: 0,
                roundWinner: winnerIndex, roundWinnerName: winnerName,
                byDeckEmpty: byDeckEmpty, gameOver: activeCount <= 1,
                lastDiscardSeat: -1, lastDiscardAt: 0, lastDiscardSnatched: true,
                snatchedCard: null, snatchRetry: false,
            });
        }

        this.broadcast({
            type: 'finished', winner: winnerIndex, winnerName: winnerName,
            scores: this.scores, eliminated: this.eliminated,
            nextRound: activeCount > 1,
        });

        if (activeCount <= 1) this._persistStats();

        this._roundTimer = setTimeout(() => {
            this._roundTimer = null;
            if (this.phase === 'closed') return;
            if (activeCount <= 1) {
                this.phase = 'gameOver';
                const gameWinner = this.eliminated.map((e, i) => e ? -1 : i).filter((i) => i >= 0);
                const finalMsg = gameWinner.length === 0
                    ? 'Game over.'
                    : `${this.clients[gameWinner[0]].name} won the game!`;
                this.broadcast({ type: 'error', message: finalMsg });
                return;
            }
            this.currentRound++;
            for (let i = 0; i < this.clients.length; i++) {
                this.hands[i] = [];
                this.hasMeldedArr[i] = false;
                this.previousScores[i] = this.scores[i];
                this.foulsThisRound[i] = 0;
                this.bannedCovers[i] = new Set();
                this.snatchRetries[i] = false;
            }
            this.currentSeat = nextStarter;
            this._dealNewRound();
        }, 3000);
    }

    _persistStats() {
        const activeCount = this.eliminated.filter((e) => !e).length;
        if (activeCount > 1) return;
        const winnerIdx = this.eliminated.findIndex((e) => !e);

        for (let i = 0; i < this.clients.length; i++) {
            const c = this.clients[i];
            if (!c.userId) continue;
            const won = i === winnerIdx;
            const xpDelta = won ? 100 : 25;
            const starDelta = won ? 10 : 2;
            const coinDelta = won ? 50 : 10;

            db.incrementStats(c.userId, {
                won, scoreDelta: this.scores[i] || 0,
                xpDelta, starDelta, coinDelta,
            })
                .then(async (u) => {
                    if (!u) return;
                    let level = u.level, xp = u.xp, xpMax = u.xpMax;
                    let leveled = false;
                    while (xp >= xpMax) {
                        xp -= xpMax;
                        level += 1;
                        xpMax = Math.floor(xpMax * 1.15);
                        leveled = true;
                    }
                    let final = u;
                    if (leveled) {
                        final = await db.updateProfile(u._id.toString(), { level, xp, xpMax });
                    }
                    if (final && c.ws.readyState === WebSocket.OPEN) {
                        c.send({ type: 'profile_updated', profile: db.publicProfile(final) });
                    }
                })
                .catch((e) => console.error('[stats] persist failed:', e));
        }
    }

    handleAction(seat, action, payload) {
        if (this.phase !== 'playing') return this._err(seat, 'Game not running');
        if (this.eliminated[seat]) return this._err(seat, 'You are eliminated');

        if (action === 'snatch') return this._actSnatch(seat);
        if (action === 'cancel_snatch') return this._actCancelSnatch(seat);

        if (seat !== this.currentSeat) return this._err(seat, 'Not your turn');

        switch (action) {
            case 'draw_deck': return this._actDrawDeck(seat);
            case 'draw_discard': return this._actDrawDiscard(seat);
            case 'discard': return this._actDiscard(seat, payload.card, payload.forced);
            case 'meld': return this._actMeld(seat, payload);
            case 'meld_batch': return this._actMeldBatch(seat, payload);
            case 'layoff': return this._actLayoff(seat, payload);
            case 'replace_joker': return this._actReplaceJoker(seat, payload);
            case 'cancel_melds': return this._actCancelMelds(seat);
            case 'foul': this._addFoul(seat, payload.reason || 'foul'); this._bumpAll(); return;
            case 'pass': return this._advanceTurn();
        }
        this._err(seat, 'Unknown action: ' + action);
    }

    _err(seat, msg) {
        if (seat < 0 || seat >= this.clients.length) return;
        this.clients[seat].send({ type: 'error', message: msg });
    }
    _bumpAll() {
        for (let i = 0; i < this.clients.length; i++) this.sendStateTo(i);
    }

    _canPickupDiscard(seat) {
        if (!this.discard.length) return false;
        const top = this.discard[this.discard.length - 1];
        const hand = this.hands[seat];
        for (let i = 0; i < hand.length - 1; i++) {
            for (let j = i + 1; j < hand.length; j++) {
                if (Meld.tryCreate([hand[i], hand[j], top]) != null) return true;
            }
        }
        return false;
    }

    _actDrawDeck(seat) {
        if (this.turnPhase !== 'draw') return this._err(seat, 'You already drew');
        if (this.snatchedCards[seat]) return this._err(seat, 'Play your snatched card first');
        if (this.hands[seat].length >= MAX_HAND_SIZE)
            return this._err(seat, 'Discard a card first');
        if (!this.deck.length) return this._endRound(true, null);

        this.hands[seat].push(this.deck.pop());
        this.turnPhase = 'discard';
        this.snatchRetries[seat] = false;
        this._bumpAll();
    }

    _actDrawDiscard(seat) {
        if (this.turnPhase !== 'draw') return this._err(seat, 'You already drew');
        if (this.snatchedCards[seat]) return this._err(seat, 'Play your snatched card first');
        if (this.hands[seat].length >= MAX_HAND_SIZE)
            return this._err(seat, 'Discard a card first');
        if (!this.discard.length) return this._err(seat, 'Discard pile is empty');
        if (!this.snatchRetries[seat] && !this._canPickupDiscard(seat))
            return this._err(seat, 'Cannot use top of discard');

        const card = this.discard.pop();
        this.hands[seat].push(card);
        this.turnPhase = 'discard';
        this.lastDiscardSnatched = true;
        this.snatchRetries[seat] = false;
        this.snatchedCards[seat] = {
            card: card, discarder: -1, isSnatch: false, melded: false,
        };
        this._bumpAll();
    }

    _topDiscardWasFoul() {
        if (!this.discard.length) return false;
        const top = this.discard[this.discard.length - 1];
        if (top.joker) return true;
        for (const entry of this.melds) {
            if (entry.meld.canLayoff(top)) return true;
        }
        return false;
    }

    _isBanned(seat, card) {
        const set = this.bannedCovers[seat];
        if (!set) return false;
        return set.has(cardKey(card));
    }

    _actSnatch(seat) {
        const n = this.clients.length;
        if (this.turnPhase !== 'draw') return this._err(seat, 'not-draw-phase');
        if (this.currentSeat !== seat) return this._err(seat, 'not-your-turn');
        if (this.hands[seat].length < 2) return this._err(seat, 'hand-too-small');
        if (!this.discard.length) return this._err(seat, 'empty-discard');
        if (this.lastDiscardSnatched) return this._err(seat, 'already-snatched');
        if (this.snatchedCards[seat]) return this._err(seat, 'already-snatching');

        const leftNeighbor = (seat - 1 + n) % n;
        if (this.lastDiscardSeat !== leftNeighbor) {
            return this._err(seat, 'not-from-left-neighbor');
        }

        const elapsed = Date.now() - this.lastDiscardAt;
        if (elapsed > SNATCH_WINDOW_MS) return this._err(seat, 'snatch-window-closed');

        const card = this.discard.pop();
        this.hands[seat].push(card);
        this.turnPhase = 'discard';
        this.snatchRetries[seat] = false;
        this.snatchedCards[seat] = {
            card: card, discarder: this.lastDiscardSeat, isSnatch: true, melded: false,
        };
        this.lastDiscardSnatched = true;

        this._bumpAll();
    }

    _actCancelSnatch(seat) {
        if (this.turnPhase !== 'discard')
            return this._err(seat, 'not-discard-phase');
        if (this.currentSeat !== seat) return this._err(seat, 'not-your-turn');
        const st = this.snatchedCards[seat];
        if (!st) return this._err(seat, 'no-snatch');
        if (st.melded) return this._err(seat, 'already-melded');

        const si = this.hands[seat].findIndex((c) => cardsEqual(c, st.card));
        if (si !== -1) this.hands[seat].splice(si, 1);
        this.discard.push(st.card);

        this.snatchedCards[seat] = null;
        this.turnPhase = 'draw';
        this.lastDiscardSeat = -1;
        this.lastDiscardSnatched = false;
        this.snatchRetries[seat] = true;

        this._bumpAll();
    }

    _actDiscard(seat, card, forced) {
        if (this.turnPhase !== 'discard') return this._err(seat, 'Draw a card first');
        if (!card) return this._err(seat, 'No card');

        const idx = this.hands[seat].findIndex((c) => cardsEqual(c, card));
        if (idx === -1) return this._err(seat, 'Card not in hand');

        if (this.snatchedCards[seat]) {
            const st = this.snatchedCards[seat];
            if (!st.melded) {
                if (st.isSnatch) {
                    this.snatchedCards[seat] = null;
                } else {
                    const si = this.hands[seat].findIndex((c) => cardsEqual(c, st.card));
                    if (si !== -1) this.hands[seat].splice(si, 1);
                    this.discard.push(st.card);
                    this.snatchedCards[seat] = null;
                    this.lastDiscardAt = Date.now();
                    this.lastDiscardSeat = seat;
                    this.lastDiscardSnatched = false;
                    this._addFoul(seat, 'pickup-not-melded');
                    if (this.eliminated[seat]) {
                        this._checkRoundEnd();
                        if (this.phase === 'playing') this._advanceTurn();
                        return;
                    }
                    this._advanceTurn();
                    return;
                }
            }
        }

        const myCard = this.hands[seat][idx];
        const prevWasFoul = this._topDiscardWasFoul();
        const isLastCard = this.hands[seat].length === 1;

        if (!forced && !isLastCard && !this._isBanned(seat, myCard)) {
            let foulReason = null;
            if (myCard.joker) foulReason = 'Discarded a joker';
            else {
                for (const entry of this.melds) {
                    if (entry.meld.canLayoff(myCard)) { foulReason = 'Discarded a cover'; break; }
                }
            }
            if (foulReason) {
                this.bannedCovers[seat].add(cardKey(myCard));
                this._addFoul(seat, foulReason);
                if (this.eliminated[seat]) {
                    this._checkRoundEnd();
                    if (this.phase === 'playing') this._advanceTurn();
                    return;
                }
                this._err(seat, foulReason + ' — pick another card');
                this._bumpAll();
                return;
            }
        }

        if (!this.hasMeldedArr[seat]) {
            const totalThisTurn = this.meldsThisTurnValue() + this.coversThisTurnValue;
            if (totalThisTurn >= this.openThreshold()) {
                this.hasMeldedArr[seat] = true;
                this.updateThreshold(seat, totalThisTurn);
            } else if (this.meldsThisTurn.length > 0) {
                this._addFoul(seat, 'Incomplete meld');
                this._revertMeldsThisTurn(seat);
                if (this.eliminated[seat]) {
                    this._checkRoundEnd();
                    if (this.phase === 'playing') this._advanceTurn();
                    return;
                }
            }
        } else {
            const turnAdded = this.meldsThisTurnValue() + this.coversThisTurnValue;
            this.updateThreshold(seat, turnAdded);
        }

        this.hands[seat].splice(idx, 1);
        this.discard.push(card);
        this.lastDiscardAt = Date.now();
        this.lastDiscardSeat = seat;
        this.lastDiscardSnatched = false;
        this.snatchRetries[seat] = false;

        this._checkRoundEnd();
        if (this.phase === 'playing') this._advanceTurn();
    }

    _revertMeldsThisTurn(seat) {
        const ids = new Set(this.meldsThisTurn);
        const reverted = [];
        this.melds = this.melds.filter((m) => {
            if (ids.has(m.id)) { reverted.push(m); return false; }
            return true;
        });
        for (const m of reverted) {
            for (const c of m.meld.cards) this.hands[seat].push(c);
        }
        this.meldsThisTurn = [];
        this.coversThisTurnValue = 0;
    }

    _actCancelMelds(seat) {
        if (this.turnPhase !== 'discard') return this._err(seat, 'Draw a card first');
        if (this.meldsThisTurn.length === 0) return;
        this._revertMeldsThisTurn(seat);
        this._bumpAll();
    }

    _parseJokerMaps(payload) {
        const jr = {};
        if (payload && payload.jokerRanks && typeof payload.jokerRanks === 'object') {
            for (const k of Object.keys(payload.jokerRanks)) {
                const key = parseInt(k, 10);
                if (!isNaN(key)) jr[key] = payload.jokerRanks[k];
            }
        }
        const js = {};
        if (payload && payload.jokerSuits && typeof payload.jokerSuits === 'object') {
            for (const k of Object.keys(payload.jokerSuits)) {
                const key = parseInt(k, 10);
                const v = payload.jokerSuits[k];
                if (!isNaN(key) && v != null) js[key] = v;
            }
        }
        return { jr, js };
    }

    _checkPickedMelded(seat) {
        if (!this.snatchedCards[seat]) return;
        const st = this.snatchedCards[seat];
        const onTable = this.melds.some((m) =>
            m.meld.cards.some((c) => cardsEqual(c, st.card)));
        if (onTable) st.melded = true;
    }

    _removeCardsFromHand(seat, cards) {
        const remaining = [...this.hands[seat]];
        for (const c of cards) {
            const i = remaining.findIndex((h) => cardsEqual(h, c));
            if (i === -1) return false;
            remaining.splice(i, 1);
        }
        for (const c of cards) {
            const i = this.hands[seat].findIndex((h) => cardsEqual(h, c));
            this.hands[seat].splice(i, 1);
        }
        return true;
    }

    _actMeld(seat, payload) {
        if (this.turnPhase !== 'discard') return this._err(seat, 'Draw a card first');
        const cards = (payload && payload.cards) || [];
        if (cards.length < 3) return this._err(seat, 'Minimum 3 cards');

        const { jr, js } = this._parseJokerMaps(payload);
        const m = Meld.tryCreate(cards, { owner: seat, jokerRanks: jr, jokerSuits: js });
        if (!m) return this._err(seat, 'Not a valid meld');

        if (!this._removeCardsFromHand(seat, cards))
            return this._err(seat, 'Card not in hand');

        const id = this._meldsId++;
        this.melds.push({ id, owner: seat, meld: m });
        this.meldsThisTurn.push(id);
        m.lockValue();

        this._checkPickedMelded(seat);
        this._checkRoundEnd();
        if (this.phase === 'playing') this._bumpAll();
    }

    _actMeldBatch(seat, payload) {
        if (this.turnPhase !== 'discard') return this._err(seat, 'Draw a card first');
        const melds = (payload && payload.melds) || [];
        if (!Array.isArray(melds) || melds.length === 0)
            return this._err(seat, 'No melds');

        const validated = [];
        for (const item of melds) {
            const cards = item.cards || [];
            if (cards.length < 3) return this._err(seat, 'Minimum 3 cards');
            const { jr, js } = this._parseJokerMaps(item);
            const m = Meld.tryCreate(cards, { owner: seat, jokerRanks: jr, jokerSuits: js });
            if (!m) return this._err(seat, 'Not a valid meld');
            validated.push({ m, cards });
        }

        for (const { cards } of validated) {
            if (!this._removeCardsFromHand(seat, cards))
                return this._err(seat, 'Card not in hand');
        }

        for (const { m } of validated) {
            const id = this._meldsId++;
            this.melds.push({ id, owner: seat, meld: m });
            this.meldsThisTurn.push(id);
            m.lockValue();
        }

        this._checkPickedMelded(seat);
        this._checkRoundEnd();
        if (this.phase === 'playing') this._bumpAll();
    }

    _actLayoff(seat, payload) {
        if (this.turnPhase !== 'discard') return this._err(seat, 'Draw a card first');
        const card = payload && payload.card;
        const meldId = payload && payload.meldId;
        if (!card || meldId == null) return this._err(seat, 'Missing card or meld');
        const entry = this.melds.find((m) => m.id === meldId);
        if (!entry) return this._err(seat, 'Meld not found');
        const hi = this.hands[seat].findIndex((h) => cardsEqual(h, card));
        if (hi === -1) return this._err(seat, 'Card not in hand');
        if (this._isBanned(seat, card)) return this._err(seat, 'That card is banned (foul)');

        const myTotal = this.meldsThisTurnValue() + this.coversThisTurnValue +
            (card.joker ? 0 : valueForRank(card.rank));
        const own = this.meldsThisTurn.includes(meldId);
        const canCover = this.hasMeldedArr[seat] || own || (myTotal >= this.openThreshold());
        if (!canCover) return this._err(seat, 'Cannot cover yet');

        if (card.joker) {
            if (!payload.jokerRank) return this._err(seat, 'Joker rank required');
            const js = payload.jokerSuit != null ? payload.jokerSuit : undefined;
            this.hands[seat].splice(hi, 1);
            entry.meld.addJokerCard(card, payload.jokerRank, js);
            this.coversThisTurnValue += valueForRank(payload.jokerRank);
        } else {
            if (entry.meld.hasCard(card)) return this._err(seat, 'Already in meld');
            if (!entry.meld.canLayoff(card)) return this._err(seat, 'Card does not fit');
            this.hands[seat].splice(hi, 1);
            entry.meld.addCard(card);
            this.coversThisTurnValue += valueForRank(card.rank);
        }

        this._checkPickedMelded(seat);
        this._checkRoundEnd();
        if (this.phase === 'playing') this._bumpAll();
    }

    _actReplaceJoker(seat, payload) {
        if (this.turnPhase !== 'discard') return this._err(seat, 'Draw a card first');
        const card = payload && payload.card;
        const meldId = payload && payload.meldId;
        if (!card || meldId == null) return this._err(seat, 'Missing');
        const entry = this.melds.find((m) => m.id === meldId);
        if (!entry) return this._err(seat, 'Meld not found');
        if (card.joker) return this._err(seat, 'Cannot swap a joker');
        if (this._isBanned(seat, card)) return this._err(seat, 'That card is banned (foul)');
        const idx = entry.meld.jokerIndexReplaceableBy(card);
        if (idx == null) return this._err(seat, 'No joker matches');
        const own = this.meldsThisTurn.includes(meldId);
        if (!this.hasMeldedArr[seat] && !own && entry.owner !== seat)
            return this._err(seat, 'Cannot swap joker yet');
        const hi = this.hands[seat].findIndex((h) => cardsEqual(h, card));
        if (hi === -1) return this._err(seat, 'Card not in hand');
        const joker = entry.meld.cards[idx];
        entry.meld.replaceJokerAt(idx, card);
        this.hands[seat].splice(hi, 1);
        this.hands[seat].push(joker);

        this._checkPickedMelded(seat);
        this._bumpAll();
    }

    _advanceTurn() {
        if (this.snatchedCards[this.currentSeat]) {
            this.snatchedCards[this.currentSeat] = null;
        }
        this.snatchRetries[this.currentSeat] = false;
        this.meldsThisTurn = [];
        this.coversThisTurnValue = 0;

        const n = this.clients.length;
        if (n === 0) return;

        let attempts = 0;
        do {
            this.currentSeat = (this.currentSeat + 1) % n;
            attempts++;
        } while (this.eliminated[this.currentSeat] && attempts <= n);

        if (this.eliminated.every((e) => e)) {
            this._endRound(true, null);
            return;
        }

        this.turnPhase = 'draw';
        this._bumpAll();
    }

    removeClient(client) {
        const idx = this.clients.indexOf(client);
        if (idx === -1) return;
        this.clients.splice(idx, 1);
        if (this.clients.length === 0) {
            if (this._roundTimer) clearTimeout(this._roundTimer);
            this.phase = 'closed';
            return;
        }
        if (this.phase === 'playing' || this.phase === 'roundEnd') {
            this.broadcast({ type: 'room_closed', reason: 'A player left mid-game' });
            this.clients = [];
            this.phase = 'closed';
            if (this._roundTimer) clearTimeout(this._roundTimer);
            return;
        }
        if (idx === 0) {
            this.broadcast({ type: 'room_closed', reason: 'Host left' });
            this.clients = [];
            this.phase = 'closed';
            return;
        }
        this.broadcastLobby();
    }
}

// ═══════════════════════════════════════════════════════════════════
// HUB + CLIENT
// ═══════════════════════════════════════════════════════════════════
class Hub {
    constructor() { this.rooms = new Map(); }
    list() {
        const out = [];
        for (const r of this.rooms.values()) {
            if (r.phase === 'lobby' && !r.isFull()) {
                out.push({
                    id: r.id, name: r.name, host: r.hostName,
                    players: r.clients.length, capacity: r.capacity(), config: r.config,
                });
            }
        }
        return out;
    }
    get(id) { if (!id) return null; return this.rooms.get(id.toUpperCase()) || null; }
    create(name, host, config) {
        let id = null;
        for (let attempts = 0; attempts < 100; attempts++) {
            const candidate = generateRoomId();
            if (!this.rooms.has(candidate)) { id = candidate; break; }
        }
        if (!id) return null;
        const r = new Room(id, name, host, config);
        this.rooms.set(id, r);
        return r;
    }
    removeIfEmpty(id) {
        const r = this.rooms.get(id);
        if (r && (r.clients.length === 0 || r.phase === 'closed')) {
            this.rooms.delete(id);
        }
    }
}

class Client {
    constructor(ws) {
        this.ws = ws;
        this.room = null;
        this.seat = -1;
        this.name = '';
        this.userId = null;
        this.profile = null;
        this._authenticated = false;
    }
    get isAuthed() { return this._authenticated; }
    send(o) {
        if (this.ws.readyState !== WebSocket.OPEN) return;
        try { this.ws.send(JSON.stringify(o)); } catch (_) { }
    }
}

const hub = new Hub();
const activeClients = new Map();

async function attachProfile(client, user) {
    const userId = user._id.toString();

    const existing = activeClients.get(userId);
    if (existing && existing !== client) {
        try {
            existing.send({ type: 'auth_error', message: 'Signed in from another device' });
            existing.ws.close(4000, 'Kicked');
        } catch (_) { }
        existing._authenticated = false;
        activeClients.delete(userId);
    }

    client.userId = userId;
    client.profile = db.publicProfile(user);
    client.name = client.profile.displayName;
    client._authenticated = true;
    activeClients.set(userId, client);

    const token = signToken(userId);
    client.send({ type: 'auth_ok', token, profile: client.profile });
}

async function handleSignup(client, msg) {
    try {
        const result = await db.signup(msg.username, msg.password, msg.displayName);
        if (result.error) {
            client.send({ type: 'auth_error', message: result.error });
            return;
        }
        await attachProfile(client, result.user);
    } catch (e) {
        console.error('[auth] signup failed:', e);
        client.send({ type: 'auth_error', message: 'server-error' });
    }
}

async function handleLogin(client, msg) {
    try {
        const result = await db.login(msg.username, msg.password);
        if (result.error) {
            client.send({ type: 'auth_error', message: result.error });
            return;
        }
        await attachProfile(client, result.user);
    } catch (e) {
        console.error('[auth] login failed:', e);
        client.send({ type: 'auth_error', message: 'server-error' });
    }
}

async function handleResume(client, msg) {
    try {
        const userId = verifyToken(msg.token);
        if (!userId) {
            client.send({ type: 'auth_error', message: 'token-invalid' });
            return;
        }
        const user = await db.findById(userId);
        if (!user) {
            client.send({ type: 'auth_error', message: 'user-not-found' });
            return;
        }
        await attachProfile(client, user);
    } catch (e) {
        console.error('[auth] resume failed:', e);
        client.send({ type: 'auth_error', message: 'server-error' });
    }
}

async function handleUpdateProfile(client, msg) {
    if (typeof msg.displayName === 'string') {
        const dn = msg.displayName.trim().slice(0, 20);
        if (dn.length >= 1) {
            const updated = await db.updateProfile(client.userId, { displayName: dn });
            if (updated) {
                client.profile = db.publicProfile(updated);
                client.name = client.profile.displayName;
                if (client.room) client.room.broadcastLobby();
                client.send({ type: 'profile_updated', profile: client.profile });
            }
        }
    }
}

async function main() {
    try {
        await db.connect();
    } catch (e) {
        console.error('[startup] MongoDB Atlas connection failed:', e.message);
        console.error('Fix MONGODB_URI in atlas-credentials.env and try again.');
        process.exit(1);
    }

    const wss = new WebSocket.Server({ port: PORT });

    wss.on('connection', (ws) => {
        const client = new Client(ws);

        ws.on('message', async (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

            if (!client.isAuthed) {
                switch (msg.type) {
                    case 'signup': return handleSignup(client, msg);
                    case 'login': return handleLogin(client, msg);
                    case 'resume': return handleResume(client, msg);
                    default:
                        client.send({ type: 'auth_error', message: 'Not authenticated' });
                        return;
                }
            }

            switch (msg.type) {
                case 'list_rooms':
                    client.send({ type: 'rooms_list', rooms: hub.list() });
                    break;

                case 'create_room': {
                    const name = (msg.name || '').trim() || 'Table';
                    const room = hub.create(name, client.name, msg.config);
                    if (!room) return client.send({ type: 'error', message: 'Could not create room' });

                    client.room = room;
                    client.seat = 0;
                    room.clients.push(client);
                    client.send({ type: 'joined', room: room.name, roomId: room.id, seat: 0 });
                    room.broadcastLobby();
                    break;
                }

                case 'join_room': {
                    const roomId = (msg.roomId || '').trim().toUpperCase();
                    if (!roomId) return client.send({ type: 'error', message: 'Room ID required' });

                    const room = hub.get(roomId);
                    if (!room) return client.send({ type: 'error', message: 'Room not found' });
                    if (room.phase !== 'lobby') return client.send({ type: 'error', message: 'Already started' });
                    if (room.isFull()) return client.send({ type: 'error', message: 'Full' });
                    if (room.clients.some((c) => c.name === client.name))
                        return client.send({ type: 'error', message: 'Name taken' });

                    const seat = room.clients.length;
                    client.room = room;
                    client.seat = seat;
                    room.clients.push(client);
                    client.send({ type: 'joined', room: room.name, roomId: room.id, seat });
                    room.broadcastLobby();
                    break;
                }

                case 'start_game':
                    if (client.room) client.room.startGame(client);
                    break;

                case 'leave_room': {
                    const room = client.room;
                    if (!room) return;
                    const rid = room.id;
                    room.removeClient(client);
                    client.room = null; client.seat = -1;
                    hub.removeIfEmpty(rid);
                    client.send({ type: 'left' });
                    break;
                }

                case 'rematch': {
                    const room = client.room;
                    if (!room) return;
                    room.phase = 'lobby';
                    room.scores = []; room.previousScores = []; room.foulsThisRound = [];
                    room.eliminated = []; room.hands = []; room.deck = []; room.discard = [];
                    room.melds = []; room._meldsId = 1;
                    room.firstMeldMade = false; room.initialMeldTarget = 0;
                    room.thresholdOwner = null; room.thresholdOwnerTotal = 0;
                    room.meldsThisTurn = []; room.coversThisTurnValue = 0;
                    room.currentRound = 1; room.currentSeat = 0; room.turnPhase = 'draw';
                    room.hasMeldedArr = []; room.bannedCovers = [];
                    room.lastDiscardAt = 0; room.lastDiscardSeat = -1;
                    room.lastDiscardSnatched = false; room.snatchedCards = [];
                    room.snatchRetries = [];
                    if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
                    room.broadcastLobby();
                    break;
                }

                case 'action': {
                    const room = client.room;
                    if (!room) return;
                    const seat = room.clients.indexOf(client);
                    if (seat === -1) return;
                    room.handleAction(seat, msg.action, msg);
                    break;
                }

                case 'update_profile':
                    return handleUpdateProfile(client, msg);

                case 'logout': {
                    const room = client.room;
                    if (room) {
                        const rid = room.id;
                        room.removeClient(client);
                        client.room = null;
                        hub.removeIfEmpty(rid);
                    }
                    if (client.userId) activeClients.delete(client.userId);
                    client.userId = null;
                    client.profile = null;
                    client._authenticated = false;
                    client.name = '';
                    client.send({ type: 'logged_out' });
                    break;
                }
            }
        });

        ws.on('close', () => {
            if (client.userId) {
                const existing = activeClients.get(client.userId);
                if (existing === client) activeClients.delete(client.userId);
            }
            if (!client.room) return;
            const rid = client.room.id;
            client.room.removeClient(client);
            hub.removeIfEmpty(rid);
        });

        ws.on('error', () => {
            if (client.userId) {
                const existing = activeClients.get(client.userId);
                if (existing === client) activeClients.delete(client.userId);
            }
            if (!client.room) return;
            const rid = client.room.id;
            client.room.removeClient(client);
            hub.removeIfEmpty(rid);
        });
    });

    console.log(`Hareeg server on ws://0.0.0.0:${PORT}`);
    console.log(`Ready for connections with MongoDB Atlas persistence.`);
}

main().catch((e) => {
    console.error('[fatal]', e);
    process.exit(1);
});