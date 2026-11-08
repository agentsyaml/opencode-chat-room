import { app } from "./state.js";
import { initMentions } from "./mentions.js";
import { initMessages } from "./messages.js";
import { initMembers } from "./members.js";
import { initRooms } from "./rooms.js";
import { initEvents } from "./events.js";
import { initQuestions } from "./questions.js";
import { initReceipts } from "./receipts.js";
import { initAnnouncements } from "./announcements.js";

initMentions(app);
initMessages(app);
initReceipts(app);
initMembers(app);
initRooms(app);
initQuestions(app);
initEvents(app);
initAnnouncements(app);
