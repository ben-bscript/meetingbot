import fs from "fs";
import puppeteer, { Browser, Page } from "puppeteer";
import { launch, getStream, wss } from "puppeteer-stream";
import { BotConfig, EventCode, WaitingRoomTimeoutError } from "../../src/types";
import { Bot } from "../../src/bot";
import path from "path";
import { Transform } from "stream";

const leaveButtonSelector = 'button#hangup-button, button[data-inp="hangup-button"], button[data-tid="hangup-button"], button[aria-label="Leave"], [data-tid="call-leave-button"], button[aria-label="Leave (Ctrl+Shift+H)"], button[aria-label="Leave (⌘+Shift+H)"],button[aria-label="Leave"], button[data-tid][data-inp="hangup-button"]';
export class TeamsBot extends Bot {
  lastParticipantCount: number;
  aloneStartTime: number | null;
  recordingPath: string;
  contentType: string;
  url: string;
  participants: string[];
  participantsIntervalId: NodeJS.Timeout;
  meetingStatusCheckId: NodeJS.Timeout;
  browser!: Browser;
  page!: Page;
  file!: fs.WriteStream;
  stream!: Transform;

  constructor(
    botSettings: BotConfig,
    onEvent: (eventType: EventCode, data?: any) => Promise<void>
  ) {
    super(botSettings, onEvent);
    this.recordingPath = `./recording.mp3`;
    this.contentType = "audio/mpeg";
    
    // Use the meeting URL directly if provided, otherwise construct it from individual parameters
    if (this.settings.meetingInfo.meetingUrl) {
      this.url = this.settings.meetingInfo.meetingUrl;
      
      // Check if suppressPrompt=true is in the URL, if not add it
      if (!this.url.includes("suppressPrompt=true")) {
        const urlObj = new URL(this.url);
        urlObj.searchParams.set("suppressPrompt", "true");
        this.url = urlObj.toString();
      }
      
      console.log("Using meeting URL:", this.url);
    } else {
      throw new Error("Either meetingUrl or (meetingId, tenantId, and organizerId) must be provided");
    }
    
    this.participants = [];
    this.participantsIntervalId = setInterval(() => { }, 0);
    this.meetingStatusCheckId = setInterval(() => { }, 0);
    this.lastParticipantCount = 0;
    this.aloneStartTime = null;
  }

  getRecordingPath(): string {
    return this.recordingPath;
  }

  getContentType(): string {
    return this.contentType;
  }

  async screenshot(fName: string = "screenshot.png") {
    try {
      if (!this.page) throw new Error("Page not initialized");
      if (!this.browser) throw new Error("Browser not initialized");

      const screenshot = await this.page.screenshot({
        type: "png",
        encoding: "binary",
      });

      // Save the screenshot to a file
      const screenshotPath = path.resolve(`/tmp/${fName}`);
      fs.writeFileSync(screenshotPath, screenshot);
      console.log(`Screenshot saved to ${screenshotPath}`);
    } catch (e) {
      console.log('Error taking screenshot:', e);
    }
  }


  async launchBrowser() {

    // Launch the browser and open a new blank page
    this.browser = await launch({
      executablePath: puppeteer.executablePath(),
      headless: "new",
      // args: ["--use-fake-ui-for-media-stream"],
      args: ["--no-sandbox"],
      protocolTimeout: 0,
    }) as unknown as Browser;

    // Parse the URL
    console.log("Parsing URL:", this.url);
    const urlObj = new URL(this.url);

    // Override camera and microphone permissions
    const context = this.browser.defaultBrowserContext();
    context.clearPermissionOverrides();
    context.overridePermissions(urlObj.origin, ["camera", "microphone"]);

    // Open a new page
    this.page = await this.browser.newPage();
    console.log('Opened Page');
  }

  async tryClickWithTimeout(selector: string, timeoutMs: number, description: string): Promise<boolean> {
    const startTime = Date.now();
    let success = false;
    
    while (Date.now() - startTime < timeoutMs && !success) {
      try {
        await this.page.locator(selector).click();
        console.log(`Successfully ${description}`);
        success = true;
      } catch (error) {
        console.log(`Retrying ${description}...`);
        // Use page.evaluate to create a delay instead of waitForTimeout
        await this.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 1000)));
      }
    }
    
    return success;
  }

  async joinMeeting() {

    await this.launchBrowser();

    // Navigate the page to a URL
    const urlObj = new URL(this.url);
    console.log("Navigating to URL:", urlObj.href);
    await this.page.goto(urlObj.href);

    // Try to click the join on web button with a 5-second timeout
    const joinedOnWeb = await this.tryClickWithTimeout(
      `[data-tid="joinOnWeb"]`, 
      5000, 
      'joined on Web'
    );
    
    if (!joinedOnWeb) {
      console.log('Could not click "Join on Web" button within timeout, continuing...');
    }

    // Helper function for delay between retries
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5 seconds

    // Fill in the display name with retries
    let displayNameSuccess = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !displayNameSuccess; attempt++) {
      try {
        console.log(`Entering display name (attempt ${attempt}/${MAX_RETRIES})...`);
        await this.page.waitForSelector(`[data-tid="prejoin-display-name-input"]`, { visible: true, timeout: 5000 });
        await this.page
          .locator(`[data-tid="prejoin-display-name-input"]`)
          .fill(this.settings.botDisplayName ?? "Meeting Bot");
        console.log('Successfully entered Display Name');
        displayNameSuccess = true;
      } catch (err) {
        console.error(`Failed to enter display name (attempt ${attempt}/${MAX_RETRIES}):`, err);
        if (attempt === MAX_RETRIES) {
          throw new Error('Failed to join meeting: Could not enter display name after multiple attempts');
        }
        await wait(RETRY_DELAY);
        console.log(`Retrying display name entry in 5 seconds...`);
      }
    }

    // Mute microphone before joining with retries
    let micMuteSuccess = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !micMuteSuccess; attempt++) {
      try {
        console.log(`Muting microphone (attempt ${attempt}/${MAX_RETRIES})...`);
        await this.page.waitForSelector(`[data-tid="toggle-mute"]`, { visible: true, timeout: 5000 });
        await this.page.locator(`[data-tid="toggle-mute"]`).click();
        console.log('Successfully muted Microphone');
        micMuteSuccess = true;
      } catch (err) {
        console.error(`Failed to mute microphone (attempt ${attempt}/${MAX_RETRIES}):`, err);
        if (attempt === MAX_RETRIES) {
          console.warn('Could not mute microphone after multiple attempts. Continuing anyway.');
          break;
        }
        await wait(RETRY_DELAY);
        console.log(`Retrying microphone mute in 5 seconds...`);
      }
    }

    // Join the meeting with retries
    let joinSuccess = false;
    for (let attempt = 1; attempt <= MAX_RETRIES && !joinSuccess; attempt++) {
      try {
        console.log(`Joining meeting (attempt ${attempt}/${MAX_RETRIES})...`);
        // First check if join button exists and is visible
        await this.page.waitForSelector(`[data-tid="prejoin-join-button"]`, { visible: true, timeout: 5000 });
        
        // Get the button and click it
        const joinButton = await this.page.$(`[data-tid="prejoin-join-button"]`);
        if (!joinButton) {
          throw new Error("Join button not found even after waiting");
        }
        
        await joinButton.click();
        console.log('Successfully clicked the Join Button');
        joinSuccess = true;
      } catch (err) {
        console.error(`Failed to click join button (attempt ${attempt}/${MAX_RETRIES}):`, err);
        if (attempt === MAX_RETRIES) {
          throw new Error('Failed to join meeting: Join button not found or click unsuccessful after multiple attempts');
        }
        await wait(RETRY_DELAY);
        console.log(`Retrying join in 5 seconds...`);
      }
    }

    // Wait for 10 seconds
    console.log('Waiting for 10 seconds...');
    await this.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 10000)));

    const joinButton2 = await this.page.$(`[data-tid="prejoin-join-button"]`);
        if (joinButton2) {
          await joinButton2.click();
          // Wait for 10 seconds
          console.log('Waiting for 10 seconds...');
          await this.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 10000)));

        }
        
        console.log('Successfully clicked the Join Button');
        joinSuccess = true;
    // Wait until join button is disabled or disappears
    try {
      console.log('Waiting for join button to be disabled or disappear...');
      await this.page.waitForFunction(
        (selector) => {
          const joinButton = document.querySelector(selector);
          return !joinButton || joinButton.hasAttribute("disabled");
        },
        { timeout: 10000 }, // 10 second timeout
        '[data-tid="prejoin-join-button"]'
      );
      console.log('Join button is now disabled or has disappeared - successfully proceeding');
    } catch (err) {
      console.error('Error while waiting for join button to be disabled:', err);
      console.warn('Join button may not have been disabled - attempting to continue anyway');
      
      // Take a screenshot to help diagnose the issue
      try {
        await this.screenshot('join-button-state-error.png');
        console.log('Captured screenshot of join button state issue');
      } catch (screenshotErr) {
        console.error('Failed to capture screenshot:', screenshotErr);
      }
    }

    // Check if we're in a waiting room by checking if the join button exists and is disabled
    const joinButton = await this.page.$('[data-tid="prejoin-join-button"]');
    const isWaitingRoom =
      joinButton &&
      (await joinButton.evaluate((button) => button.hasAttribute("disabled")));

    let timeout = 30000; // if not in the waiting room, wait 30 seconds to join the meeting
    if (isWaitingRoom) {
      console.log(
        `Joined waiting room, will wait for ${this.settings.automaticLeave.waitingRoomTimeout > 60 * 1000
          ? `${this.settings.automaticLeave.waitingRoomTimeout / 60 / 1000
          } minute(s)`
          : `${this.settings.automaticLeave.waitingRoomTimeout / 1000
          } second(s)`
        }`
      );

      // if in the waiting room, wait for the waiting room timeout
      timeout = this.settings.automaticLeave.waitingRoomTimeout; // in milliseconds
    }

    // wait for the leave button to appear (meaning we've joined the meeting)
    console.log('Waiting for the ability to leave the meeting (when I\'m in the meeting...)', timeout, 'ms')
    try {
      await this.page.waitForSelector(leaveButtonSelector, {
        timeout: timeout,
      });
    } catch (error) {
      // Distinct error from regular timeout
      throw new WaitingRoomTimeoutError();
    }

    // Log Done
    console.log("Successfully joined meeting");
  }


  // Ensure we're not kicked from the meeting
  async checkKicked() {
    // TOOD: Implement this
    return false;
  }

  async startRecording() {
    if (!this.page) throw new Error("Page not initialized");

    // Get the stream - audio only
    this.stream = await getStream(
      this.page as any, //puppeteer type issue
      { audio: true, video: false },
    );

    // Create a file
    this.file = fs.createWriteStream(this.getRecordingPath());
    this.stream.pipe(this.file);

    // Pipe the stream to a file
    console.log("Recording audio only...");
  }

  async stopRecording() {
    // Stop recording
    if (this.stream) {
      console.log("Stopping recording...");
      try {
        this.stream.destroy();
        console.log("Recording stream destroyed successfully");
      } catch (error) {
        console.log("Error destroying recording stream:", error);
      }
    }
  }


  async run() {

    // Start Join
    await this.joinMeeting();

    //Create a File to record to
    this.file = fs.createWriteStream(this.getRecordingPath());
    await this.startRecording();


        // Periodic check for meeting status in parallel with waiting for the leave button
        this.meetingStatusCheckId = setInterval(async () => {
          try {
            const isMeetingActive = await this.checkMeetingStatus();
            if (!isMeetingActive) {
              console.log("Meeting detected as ended during status check");
              clearInterval(this.meetingStatusCheckId);
              await this.endLife();
            }
          } catch (error) {
            console.log("Error in meeting status check interval:", error);
          }
        }, 10000); // Check every 10 seconds
    
    // Click the people button
    console.log("Opening the participants list");
    await this.page.locator('[aria-label="People"]').click();

    // Wait for the attendees tree to appear
    console.log("Waiting for the attendees tree to appear");
    const tree = await this.page.waitForSelector('[role="tree"]');
    console.log("Attendees tree found");

    const updateParticipants = async () => {
      try {
        const currentParticipants = await this.page.evaluate(() => {
          const participantsList = document.querySelector('[role="tree"]');
          if (!participantsList) {
            console.log("No participants list found");
            return [];
          }

          const currentElements = Array.from(
            participantsList.querySelectorAll(
              '[data-tid^="attendeesInMeeting-"], [data-tid^="participantsInCall-"]'
            )
          );

          return currentElements
            .map((el) => {
              const nameSpan = el.querySelector("span[title]");
              return (
                nameSpan?.getAttribute("title") ||
                nameSpan?.textContent?.trim() ||
                ""
              );
            })
            .filter((name) => name);
        });

        this.participants = currentParticipants;

                // Check if this bot is alone in the meeting              
                if (this.participants.length <= 1) {
                  // Bot is alone or no one is in the meeting
                  if (this.aloneStartTime === null) {
                    console.log("Bot is now alone in the meeting, starting timer");
                    this.aloneStartTime = Date.now();
                  } else {
                    const aloneTimeMs = Date.now() - this.aloneStartTime;
                    console.log(`Bot is alone for ${aloneTimeMs / 1000} seconds`);
                    
                    if (aloneTimeMs > (this.settings.automaticLeave?.everyoneLeftTimeout || 30000)) {
                      console.log("No other participants for too long, leaving the meeting");
                      // Leave the meeting by clicking the leave button
                      try {
                        await this.page.locator(leaveButtonSelector).click();
                        clearInterval(this.participantsIntervalId);
                        console.log("Left meeting due to no other participants");
                        await this.endLife();
                      } catch (error) {
                        console.log("Error clicking leave button:", error);
                        clearInterval(this.participantsIntervalId);
                        await this.endLife();
                      }
                    }
                  }
                } else {
                  // Reset alone timer if other participants join
                  if (this.aloneStartTime !== null) {
                    console.log("Bot is no longer alone in the meeting, resetting timer");
                    this.aloneStartTime = null;
                  }
                }
                
                // Track participant count changes
                if (this.participants.length !== this.lastParticipantCount) {
                  console.log(`Participant count changed: ${this.lastParticipantCount} -> ${this.participants.length}`);
                  this.lastParticipantCount = this.participants.length;
                }

        
      } catch (error) {
        console.log("Error getting participants:", error);
      }
    };

    // Get initial participants list
    await updateParticipants();
    console.log("Checking participants");

    // Then check for participants every heartbeatInterval milliseconds
    this.participantsIntervalId = setInterval(
      updateParticipants,
      this.settings.heartbeatInterval
    );



    // Then wait for meeting to end by watching for the "Leave" button to disappear
    await this.page.waitForFunction(
      (selector) => !document.querySelector(selector),
      { timeout: 0 }, // wait indefinitely
      leaveButtonSelector
    ).catch(error => {
      console.log("Error waiting for leave button to disappear:", error);
    });
     console.log("Meeting ended (leave button disappeared endlife)");

    await this.endLife();
    // console.log("Meeting ended (leave button disappeared)");
    // clearInterval(this.meetingStatusCheckId);

    // // Clear the participants checking interval
    // clearInterval(this.participantsIntervalId);

  }

  /**
   * Check if the meeting is still active by examining various UI elements
   * @returns {Promise<boolean>} true if meeting is active, false if it appears to be ended
   */
  async checkMeetingStatus(): Promise<boolean> {
    try {
      return await this.page.evaluate((leaveSelector) => {
        // Check if leave button exists
        const leaveButton = document.querySelector(leaveSelector);
        if (!leaveButton) {
          console.log("Leave button not found - meeting likely ended");
          return false;
        }
             
        // Check for the anonymous meeting end screen
        const anonMessage = document.querySelector('[data-tid="anon-meeting-end-screen-header"]');
        if (anonMessage) {
          console.log("Anonymous meeting end screen detected");
          return false;
        }

        const rejoinButton = document.querySelector('[data-tid="anon-meeting-end-screen-rejoin-button"]');
        if (rejoinButton) {
          console.log("Rejoin button found");
          return false;
        }

        
        return true;
      }, leaveButtonSelector);
    } catch (error) {
      console.log("Error checking meeting status:", error);
      return true; // Assume meeting is still active if there's an error checking
    }
  }

  /**
   * Clean Resources, close the browser.
   * Ensure the filestream is closed as well.
   */
  async endLife() {
    console.log("Ending life as was called");
    try {
      // First stop recording before closing anything
      if (this.stream) {
        console.log("Stopping recording stream...");
        await this.stopRecording();
      }
      
      // Close File if it exists
      if (this.file) {
        console.log("Closing recording file...");
        this.file.close();
        this.file = null as any;
      }

      // Clear any intervals or timeouts to prevent open handles
      if (this.participantsIntervalId) {
        console.log("Clearing intervals...");
        clearInterval(this.participantsIntervalId);
      }
      if (this.meetingStatusCheckId) {
        console.log("Clearing meeting status check interval...");
        clearInterval(this.meetingStatusCheckId);
      }

      // Finally close Browser
      if (this.browser) {
        console.log("Closing browser...");
        try {
          await this.browser.close();
          console.log("Browser closed successfully");
        } catch (err) {
          console.log("Error closing browser:", err);
        }

        // Close the websocket server
        try {
          (await wss).close();
          console.log("Closed websocket server");
        } catch (err) {
          console.log("Error closing websocket server:", err);
        }
      }
      
      console.log("Bot shutdown complete");
    } catch (error) {
      console.error("Error during bot shutdown:", error);
    }
  }
}
