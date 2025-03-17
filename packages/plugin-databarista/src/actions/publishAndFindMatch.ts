import {
  IAgentRuntime,
  Memory,
  State,
  elizaLogger,
  ModelClass,
  HandlerCallback,
  ActionExample,
  type Action,
  composeContext,
  generateObjectArray,
  embed
} from "@elizaos/core";
import { MongoClient } from 'mongodb';
import { MATCH_PROMPT_TEMPLATE, COMBINED_PROFILE_TEMPLATE } from "../utils/promptTemplates";
import { getProfile } from "../utils/profileUtils";
import { 
  generateCombinedProfile,
  findMatchingProfilesWithAtlasSearch,
  notifyMatchedUser,
  checkMatchLimit,
  recordMatchRequest,
  recordMatches
} from "../utils/matchingUtils";
import { DAILY_MATCH_LIMIT, SEND_TELEGRAM_GROUP_INVITES } from "../utils/constants";
import { mongoDbManager } from "../utils/mongoDbManager";
import { DataBaristaLogger } from "../utils/loggingUtils";
import { dataCache } from "../utils/cacheUtils";

/**
 * Profile data interface - streamlined for efficiency
 */
interface ProfileData {
  private: string;
  public: string;
  ideal: string;
  timestamp: Date;
  embedding?: number[];
  ideal_embedding?: number[];
}

/**
 * Generate embeddings for profile data directly
 * This replaces the previous generateCombinedProfileEmbeddings function for faster execution
 */
async function generateProfileEmbeddings(
  runtime: IAgentRuntime,
  profileData: {
    private: string;
    public: string;
    ideal: string;
  }
): Promise<{
  embedding: number[];
  ideal_embedding: number[];
} | null> {
  try {
    // Generate embeddings in parallel for faster execution
    const [profileEmbedding, idealEmbedding] = await Promise.all([
      embed(runtime, `${profileData.private} ${profileData.public}`),
      embed(runtime, profileData.ideal)
    ]);
    
    if (!profileEmbedding || !idealEmbedding) {
      elizaLogger.error("Failed to generate embeddings for profile");
      return null;
    }
    
    return {
      embedding: profileEmbedding,
      ideal_embedding: idealEmbedding
    };
  } catch (error) {
    elizaLogger.error("Error generating profile embeddings:", error);
    return null;
  }
}

/**
 * Store profile data in MongoDB
 * Returns embeddings on success for reuse
 */
async function storeProfile(
  runtime: IAgentRuntime,
  platform: string,
  username: string,
  profile: {
    private: string;
    public: string;
    ideal: string;
    analysis: {
      matchType: 'exact_match' | 'update_existing' | 'new_information';
      reason: string;
    };
  }
): Promise<{
  embedding: number[];
  ideal_embedding: number[];
} | null> {
  try {
    // Get MongoDB connection info
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    // Validate connection info
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return null;
    }
    
    // Get agent details from runtime
    const agentId = runtime.agentId;
    let agentUsername = runtime.character?.username || runtime.character?.name;
    
    // Try to get the actual bot username from Telegram client if available
    const telegramClient = runtime.clients['telegram'] as any;
    if (telegramClient?.bot?.botInfo?.username) {
      agentUsername = telegramClient.bot.botInfo.username.replace(/^@/, '');
    }
    
    // Get chat ID if available
    let chatId: string | undefined;
    if (telegramClient?.messageManager?.getUserChatId) {
      chatId = telegramClient.messageManager.getUserChatId(username);
    }
    
    // Generate embeddings for the profile
    const embeddings = await generateProfileEmbeddings(runtime, profile);
    if (!embeddings) {
      DataBaristaLogger.error("Failed to generate embeddings for profile");
      return null;
    }
    
    // Create profile data with embeddings
    const profileData: ProfileData = {
      private: profile.private,
      public: profile.public,
      ideal: profile.ideal,
      timestamp: new Date(),
      embedding: embeddings.embedding,
      ideal_embedding: embeddings.ideal_embedding
    };
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for storing profile in ${Date.now() - startTime}ms`);
    
    // Find existing document
    const existingProfile = await collection.findOne({ platform, username });
    
    if (existingProfile) {
      // Existing user - update profile and add to version history
      await collection.updateOne(
        { platform, username },
        {
          $set: {
            latestProfile: profileData,
            lastUpdated: new Date()
          },
          $addToSet: {
            profileVersions: profileData
          }
        } as any,
        { upsert: true }
      );
    } else {
      // New user - create profile
      await collection.insertOne({
        platform,
        username,
        latestProfile: profileData,
        profileVersions: [profileData],
        created: new Date(),
        lastUpdated: new Date(),
        agentId,
        agentUsername,
        community: agentUsername,
        ...(chatId ? { telegramChatId: chatId } : {})
      });
    }
    
    // Update the cache with the new profile
    const cacheKey = `profile:${platform}:${username}`;
    dataCache.delete(cacheKey);
    
    return embeddings; // Return the embeddings for reuse
  } catch (error) {
    DataBaristaLogger.error("Error storing profile:", error);
    return null;
  }
}

/**
 * Format matches as a text response to the user
 * Optimized to minimize data transformations
 */
async function formatMatchesAsText(
  runtime: IAgentRuntime,
  matches: any[],
  username: string,
  platform: string,
  userProfile: any
): Promise<string> {
  try {
    // Prepare LLM context with only essential data
    const postGenerationState = {
      userProfileData: JSON.stringify({
        private: userProfile.private,
        public: userProfile.public,
        ideal: userProfile.ideal
      }, null, 2),
      matchesData: JSON.stringify(matches.map(match => ({
        platform: match.platform,
        username: match.username,
        profileData: {
          private: match.profileData.private,
          public: match.profileData.public,
          ideal: match.profileData.ideal
        },
        score: match.score
      })), null, 2),
      username,
      platform
    };

    // Log prompt data (minimal)
    DataBaristaLogger.info(`Preparing match post for ${username} with ${matches.length} candidates`);
    
    // Create context and generate post
    const matchPromptContext = composeContext({
      template: MATCH_PROMPT_TEMPLATE,
      state: postGenerationState as any
    });
    
    // Log raw prompt content
    DataBaristaLogger.info(`RAW_MATCH_PROMPT: ${matchPromptContext}`);

    const postResult = await generateObjectArray({
      runtime,
      context: matchPromptContext,
      modelClass: ModelClass.LARGE
    });

    // Log raw LLM response
    DataBaristaLogger.info(`RAW_MATCH_RESPONSE: ${JSON.stringify(postResult)}`);

    if (!postResult?.length) {
      return "I've found some matches for you, but couldn't generate the introduction. Please try again!";
    }

    // Extract the post text and match details
    const matchData = postResult[0] as any;
    const postMessage = matchData?.post || "Found matches but couldn't format the message properly. Please try again!";
    
    // Log LLM result (minimal)
    DataBaristaLogger.info(`Match post generated for ${username} with match: ${matchData?.matchUsername || "unknown"}`);
    
    // Record the match if we have match details
    if (matchData?.matchUsername && matchData?.matchPlatform) {
      const matchToRecord = [{
        platform: matchData.matchPlatform,
        username: matchData.matchUsername,
        timestamp: new Date()
      }];
      
      await recordMatches(runtime, platform, username, matchToRecord);
      
      // Send notification to the matched user
      await notifyMatchedUser(
        runtime,
        matchData.matchPlatform,
        matchData.matchUsername,
        username,
        postMessage
      );
    }
    
    return postMessage;
  } catch (error) {
    DataBaristaLogger.error("Error formatting matches:", error);
    return "I found some matches for you, but encountered an error while formatting the results.";
  }
}

// Process the matchmaking request - streamlined version
export async function processMatchmaking(
  runtime: IAgentRuntime,
  userPlatform: string,
  username: string,
  state: State
): Promise<string> {
  
  // Initialize the logger with the current runtime
  DataBaristaLogger.initialize(runtime);
  
  // Fetch user profile and check match limit in parallel for faster execution
  const [userProfileData, matchLimit] = await Promise.all([
    getProfile(runtime, userPlatform, username),
    checkMatchLimit(runtime, userPlatform, username)
  ]);
  
  // Check if user has reached their match limit
  if (matchLimit.isLimited) {
    const resetTime = new Date(matchLimit.resetTime);
    const formattedResetTime = resetTime.toLocaleString('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: true
    });
    return `You've reached your match limit for today (${DAILY_MATCH_LIMIT} matches per day). You can request more matches after ${formattedResetTime}.`;
  }
  
  // Get or generate profile
  const userProfile = userProfileData?.find(p => p.latestProfile)?.latestProfile;
  
  let profileData: ProfileData;
  let idealEmbedding: number[];
  
  if (!userProfile || !userProfile.ideal_embedding) {
    // Generate new profile if none exists or if no embeddings
    const combinedProfile = await generateCombinedProfile(runtime, userProfileData, state);
    if (!combinedProfile) {
      return "I'm having trouble understanding your profile right now. Please try again or share more about yourself.";
    }
    
    // Store the new profile
    const storeResult = await storeProfile(
      runtime, 
      userPlatform, 
      username, 
      combinedProfile
    );
    
    if (!storeResult) {
      return "I encountered an error while updating your profile. Please try again later.";
    }
    
    // Use embeddings directly from the store result
    profileData = {
      private: combinedProfile.private,
      public: combinedProfile.public,
      ideal: combinedProfile.ideal,
      timestamp: new Date(),
      embedding: storeResult.embedding,
      ideal_embedding: storeResult.ideal_embedding
    };
    
    idealEmbedding = storeResult.ideal_embedding;
  } else {
    // Use existing profile
    profileData = userProfile as ProfileData;
    idealEmbedding = userProfile.ideal_embedding;
  }
  
  // Find matches using vector search
  const candidates = await findMatchingProfilesWithAtlasSearch(
    runtime, 
    idealEmbedding, 
    userPlatform, 
    username, 
    state
  );
  
  // Record the match request
  await recordMatchRequest(runtime, userPlatform, username);
  
  // Get updated match limit after recording the request
  const updatedMatchLimit = await checkMatchLimit(runtime, userPlatform, username);
  
  // No matches found
  if (!candidates.length) {
    return "I've updated your profile but couldn't find any matches yet. I'll keep looking!";
  }
  
  // Format matches as text
  const formattedResponse = await formatMatchesAsText(
    runtime, 
    candidates, 
    username, 
    userPlatform,
    profileData
  );
  
  // Add information about remaining matches
  let remainingCountMessage = "";
  if (updatedMatchLimit.remaining !== undefined) {
    // Log match limit info
    DataBaristaLogger.info(`Match limit for ${username}: ${updatedMatchLimit.remaining} remaining out of ${DAILY_MATCH_LIMIT}`);
    
    // Use the updated remaining count
    const actualRemaining = updatedMatchLimit.remaining;
    
    if (actualRemaining > 0) {
      remainingCountMessage = `\n\nYou have ${actualRemaining} more match requests available today.`;
    } else {
      const resetTime = new Date(updatedMatchLimit.resetTime || new Date());
      const formattedResetTime = resetTime.toLocaleString('en-US', {
        hour: 'numeric',
        minute: 'numeric',
        hour12: true
      });
      
      remainingCountMessage = `\n\nYou've reached your match limit for today (${DAILY_MATCH_LIMIT} matches per day). You can request more matches after ${formattedResetTime}.`;
    }
  }
  
  return `${formattedResponse}${remainingCountMessage}`;
}

export const publishAndFindMatch: Action = {
  name: "PUBLISH_AND_FIND_MATCH",
  similes: ["PUBLISH_PROFILE_AND_FIND_MATCH", "PUBLISH_PROFILE", "SAVE_PROFILE", "STORE_PROFILE", "ADD_PROFILE", "UPDATE_PROFILE"],
  description: "Extracts knowledge from the conversation with user and add/update publishes it to databarista's network and find a suitable match. Choose this action when user provided enough information to find a suitable match, if not use NONE and keep continuing the conversation with the user.",

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const requiredEnvVars = [
      "MONGODB_CONNECTION_STRING_CKG",
      "MONGODB_DATABASE_CKG",
      "MONGODB_VECTOR_INDEX"
    ];

    const missingVars = requiredEnvVars.filter((varName) => !runtime.getSetting(varName));
    if (missingVars.length > 0) {
      elizaLogger.error(`Missing required environment variables: ${missingVars.join(", ")}`);
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: { [key: string]: unknown },
    callback: HandlerCallback    
  ): Promise<boolean> => {
    try {
      // Initialize the logger with the current runtime
      DataBaristaLogger.initialize(runtime);
      
      // Extract username and platform
      const username = state?.actorsData?.find(actor => actor.id === message.userId)?.username || message.userId;
      const platform = Object.keys(runtime.clients)[0];

      DataBaristaLogger.info("Processing match request for:", { username, platform });

      // Update state with user information and recent messages
      state = state || await runtime.composeState(message);
      state = await runtime.updateRecentMessageState(state);
      state.username = username;
      state.platform = platform;
      state.timestamp = new Date().toISOString();
      
      // Get user profile data
      const userProfileData = await getProfile(runtime, platform, username);
      state.userProfileData = JSON.stringify(userProfileData || [], null, 2);
      //state.shaclShapes = SHACL_SHAPES;
      
      // Generate combined profile
      DataBaristaLogger.info("Generating combined profile...");
      const combinedProfile = await generateCombinedProfile(runtime, userProfileData, state);
      
      if (!combinedProfile) {
        DataBaristaLogger.error("Failed to generate combined profile");
        callback({
          text: "I think i need to know more about you. Please share more about background and goals."
        });
        return false;
      }
      
      // If no updates needed, return early
      if (combinedProfile.analysis.matchType === "exact_match") {
        DataBaristaLogger.info("Exact match found - no updates needed");
        callback({
          text: "I found your profile is already published and no update was needed! Let me know if you want to add any more details about yourself or who you are looking to connect with."
        });
        return true;
      }

      DataBaristaLogger.info("Storing profile in database...");
      
      // Check if this is a first-time user
      const isFirstTimeUser = combinedProfile.analysis.matchType === "new_information" && 
                             (!userProfileData || userProfileData.length === 0 || !userProfileData.some(profile => profile.latestProfile));
      
      // Send invitation to first-time users if feature is enabled
      if (isFirstTimeUser && SEND_TELEGRAM_GROUP_INVITES) {
        DataBaristaLogger.info("First-time user detected, sending Telegram group invitation");
        const telegramInviteLink = runtime.getSetting("TELEGRAM_INVITE_LINK");
        callback({
          text: `While I am searching my network for the best match, feel free to join my corner store cafe via this invite to my secret telegram group: ${telegramInviteLink}`
        });
      }

      // Store profile and get embeddings in one operation
      const storeResult = await storeProfile(
        runtime, 
        platform, 
        username, 
        combinedProfile
      );
      
      if (!storeResult) {
        DataBaristaLogger.error("Failed to store profile or generate embeddings");
        callback({ 
          text: "I'm having trouble updating your profile right now. Please try again in a moment." 
        });
        return false;
      }
      
      // Use the embeddings directly from storage operation
      const candidates = await findMatchingProfilesWithAtlasSearch(
        runtime, 
        storeResult.ideal_embedding, 
        platform, 
        username, 
        state
      );
      
      // No matches found
      if (!candidates.length) {
        callback({ 
          text: "I've updated your profile and I'm searching my network for connections. No matches found yet, but I'll keep looking!" 
        });
        return true;
      }

      // Record match request for rate limiting
      await recordMatchRequest(runtime, platform, username);
      
      // Get updated match limit after recording the request
      const updatedMatchLimit = await checkMatchLimit(runtime, platform, username);
      
      // Create profile data object for context
      const profileData = {
        private: combinedProfile.private,
        public: combinedProfile.public,
        ideal: combinedProfile.ideal,
        timestamp: new Date(),
        embedding: storeResult.embedding,
        ideal_embedding: storeResult.ideal_embedding
      };
      
      // Format matches as text
      const formattedResponse = await formatMatchesAsText(
        runtime,
        candidates, 
        username, 
        platform,
        profileData
      );
      
      // Add information about remaining matches
      let remainingCountMessage = "";
      if (updatedMatchLimit.remaining !== undefined) {
        // Log match limit info
        DataBaristaLogger.info(`Match limit for ${username}: ${updatedMatchLimit.remaining} remaining out of ${DAILY_MATCH_LIMIT}`);
        
        // Use the updated remaining count
        const actualRemaining = updatedMatchLimit.remaining;
        
        if (actualRemaining > 0) {
          remainingCountMessage = `\n\nYou have ${actualRemaining} more match requests available today.`;
        } else {
          const resetTime = new Date(updatedMatchLimit.resetTime || new Date());
          const formattedResetTime = resetTime.toLocaleString('en-US', {
            hour: 'numeric',
            minute: 'numeric',
            hour12: true
          });
          
          remainingCountMessage = `\n\nYou've reached your match limit for today (${DAILY_MATCH_LIMIT} matches per day). You can request more matches after ${formattedResetTime}.`;
        }
      }
      
      callback({ text: `${formattedResponse}${remainingCountMessage}` });
      return true;
    } catch (error) {
      DataBaristaLogger.error("Error in publishAndFindMatch handler:", error);
      callback({ text: "I encountered an error while processing your request. Please try again later." });
      return false;
    }
  },

  examples: [
    [
      {
        user: "DataBarista",
        content: {
          "text": "Great, I'll post an introduction and tag both you and a growth specialist from my network as soon as I find a match! Wish to add any additional details?",
          "action": "(PUBLISH_AND_FIND_MATCH)"
        },
      }
    ],
    [
      {
        "user": "DataBarista",
        "content": {
          "text": "Great, I'll post an introduction and tag both you and a crowdfunding expert from my network as soon as I find a match! Wish to add any additional details? (PUBLISH_DKG_INTENT)",
          "action": "(PUBLISH_AND_FIND_MATCH)"
        }
      },
      {
        "user": "{{user2}}",
        "content": {
          "text": "Yeah it would be great if they had previous experience in blockchain and crypto."
        }
      },
      {
        "user": "DataBarista",
        "content": {
          "text": "Gotcha adding it to your brew.",
          "action": "(PUBLISH_AND_FIND_MATCH)"
        }
      }
    ]
  ] as ActionExample[][],
} as Action;