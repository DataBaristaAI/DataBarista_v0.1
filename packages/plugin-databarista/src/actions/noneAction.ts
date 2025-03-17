import {
    ActionExample,
    IAgentRuntime,
    Memory,
    elizaLogger,
    type Action,
} from "@elizaos/core";
//import { sendInlineKeyboardToUser, InlineKeyboardButtonType } from "../utils/telegramUtils";
//import { setupTelegramCallbackHandlers } from "../utils/telegramHandlers";

export const noneAction: Action = {
    name: "NONE",
    similes: [
        "NO_ACTION",
        "NO_RESPONSE",
        "NO_REACTION",
        "RESPONSE",
        "REPLY",
        "DEFAULT",
    ],
    validate: async (_runtime: IAgentRuntime, _message: Memory) => {
        return true;
    },
    description:
        "Respond but perform no additional action. This is the default if the agent is coversing with the user and asking followup questions.",
    handler: async (
        runtime: IAgentRuntime,
        message: Memory
    ): Promise<boolean> => {
        try {
            // Log that noneAction handler was called
            //elizaLogger.info("DATABARISTA DEBUG: noneAction handler called");
            
            // Ensure callback handlers are set up
            //if (runtime.clients['telegram'] && runtime.clients['telegram'].bot) {
                // Make sure callback handlers are initialized
                //setupTelegramCallbackHandlers(runtime.clients['telegram'].bot);
            //}
            
            // Create state object to access additional properties
            //const state = await runtime.composeState(message);
            
            // Extract username and platform the same way as in publishAndFindMatch.ts and userProfileProvider.ts
            //const username = state?.actorsData?.find(actor => actor.id === message.userId)?.username || message.userId;
            //const platform = Object.keys(runtime.clients)[0];
            
            // Log state information for debugging
            //elizaLogger.info(`DATABARISTA DEBUG: Message userId: ${message.userId}`);
            //elizaLogger.info(`DATABARISTA DEBUG: Extracted username: ${username}, platform: ${platform}`);
            
            // Check if this is a Telegram platform interaction
            //if (platform === 'telegram' && username) {
                //elizaLogger.info(`DATABARISTA DEBUG: Processing Telegram message for user: ${username}`);
                
                // Get the response text from message content
                //const responseText = message.content?.text || 'Please select an option:';
                
                // INLINE KEYBOARD FUNCTIONALITY DISABLED
                //elizaLogger.info(`DATABARISTA DEBUG: Inline keyboard functionality is currently disabled in noneAction`);
                
                /*
                // Define custom buttons for this interaction - using switch_inline_query_current_chat to pre-fill input
                const buttons: InlineKeyboardButtonType[][] = [
                    [{ 
                        type: 'switch_inline_query_current_chat', 
                        text: 'I want one more match, please call serendipitybjkbjkb jhjhbjhbjkb ibjkbk!', 
                        query: 'I want one more match, please call serendipity 1 2 3 4 5 6 7 8 8 9 10 11 12!' 
                    }],
                    [{ 
                        type: 'switch_inline_query_current_chat', 
                        text: 'I wish to update my profile', 
                        query: 'I wish to update my profile' 
                    }]
                ];
                
                // Log detailed button information
                elizaLogger.info(`DATABARISTA DEBUG: Created buttons: ${JSON.stringify(buttons, null, 2)}`);
                
                // Send the inline keyboard using our improved utility function
                // that looks up the chatId and appropriate bot token from the database
                elizaLogger.info(`DATABARISTA DEBUG: Sending inline keyboard to user: ${username}`);
                const result = await sendInlineKeyboardToUser(runtime, username, responseText, { buttons });
                elizaLogger.info(`DATABARISTA DEBUG: Inline keyboard send result: ${result}`);
                
                if (result) {
                    elizaLogger.info(`Successfully sent Telegram inline keyboard to user ${username}`);
                } else {
                    elizaLogger.warn(`Failed to send Telegram inline keyboard to user ${username}`);
                }
                */
            //} else {
                //elizaLogger.info(`DATABARISTA DEBUG: Not a valid Telegram interaction - platform: ${platform}, username: ${username}`);
            //}
        } catch (error) {
            elizaLogger.error(`Error in noneAction handler: ${error}`);
        }
        
        return true;
    },
    examples: [] as ActionExample[][],
} as Action;
