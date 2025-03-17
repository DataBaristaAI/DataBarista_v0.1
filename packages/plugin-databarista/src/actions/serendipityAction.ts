import {
    IAgentRuntime,
    Memory,
    State,
    ModelClass,
    ActionExample,
    type Action,
    composeContext,
    generateObjectArray,
    embed
  } from "@elizaos/core";
import { MATCH_PROMPT_TEMPLATE } from "../utils/promptTemplates";
import { getProfile } from "../utils/profileUtils";
import { 
  generateCombinedProfile,
  findMatchingProfilesWithAtlasSearch,
  notifyMatchedUser,
  checkMatchLimit,
  recordMatchRequest,
  recordMatches
} from "../utils/matchingUtils";
import { DAILY_MATCH_LIMIT } from "../utils/constants";
import { mongoDbManager } from "../utils/mongoDbManager";
import { DataBaristaLogger } from "../utils/loggingUtils";
import { dataCache } from "../utils/cacheUtils";

/**
 * Interface for profile data
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
      DataBaristaLogger.error("Failed to generate embeddings for profile");
      return null;
    }
    
    return {
      embedding: profileEmbedding,
      ideal_embedding: idealEmbedding
    };
  } catch (error) {
    DataBaristaLogger.error("Error generating profile embeddings:", error);
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
    
    // Log preparation information
    DataBaristaLogger.info(`Preparing match post for ${username} with ${matches.length} candidates`);
    
    // Create context and generate post
    const matchPromptContext = composeContext({
      template: MATCH_PROMPT_TEMPLATE,
      state: postGenerationState as any
    });
    
    // Log raw prompt content
    DataBaristaLogger.info(`RAW_MATCH_PROMPT: ${matchPromptContext}`);
    
    // Generate the post text from the candidate profiles
    const postResult = await generateObjectArray({
      runtime,
      context: matchPromptContext,
      modelClass: ModelClass.LARGE
    });
    
    // Log raw LLM response
    DataBaristaLogger.info(`RAW_MATCH_RESPONSE: ${JSON.stringify(postResult)}`);
    
    if (!postResult?.length) {
      return "Found matches but couldn't generate the post. Please try again later!";
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
  
export const serendipityAction: Action = {
  name: "SERENDIPITY_ACTION",
  similes: ["FIND_MATCHES", "DISCOVER_CONNECTIONS"],
  description: "Finds most compatible matches from the databarista's network and introduces them together. Choose this action when user provided enough information to find a suitable match, if not use NONE and keep continuing the conversation with the user.",
  
    validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const requiredVars = [
      "MONGODB_CONNECTION_STRING_CKG", 
      "MONGODB_DATABASE_CKG",
      "MONGODB_VECTOR_INDEX"
    ];
      return requiredVars.every(v => runtime.getSetting(v));
    },
  
  handler: async (runtime: IAgentRuntime, message: any, state?: any, _conversation?: any, callback?: any): Promise<boolean> => {
    try {
      // Initialize the logger with the current runtime
      DataBaristaLogger.initialize(runtime);
      
      if (!callback) {
        DataBaristaLogger.error("No callback function provided");
        return false;
      }

      // Get user context
      let activeState = state || {};
      const username = activeState?.actorsData?.find((actor: any) => actor.id === message.userId)?.username || message.userId;
      const platform = Object.keys(runtime.clients)[0];

      DataBaristaLogger.info("Processing serendipity request for:", { username, platform });
  
      // Fetch user profile and check match limit in parallel for faster execution
      const [userProfileData, matchLimit] = await Promise.all([
        getProfile(runtime, platform, username),
        checkMatchLimit(runtime, platform, username)
      ]);
      
      if (matchLimit.isLimited) {
        DataBaristaLogger.info(`User has reached the daily match limit of ${DAILY_MATCH_LIMIT} matches.`);
        
        const resetTime = new Date(matchLimit.resetTime || new Date());
        const formattedResetTime = resetTime.toLocaleString('en-US', {
          hour: 'numeric',
          minute: 'numeric',
          hour12: true
        });
        
        callback({ 
          text: `You've reached your match limit for today (${DAILY_MATCH_LIMIT} matches per day). You can request more matches after ${formattedResetTime}.`
        });
        return true;
      }

      if (!userProfileData || userProfileData.length === 0) {
        callback({ text: "I don't have enough information about your profile yet. Let's talk a bit more so I can understand what you're looking for." });
            return false;
          }

      // Update state with recent messages
      if (!activeState.recentMessages) {
        activeState = await runtime.composeState(message);
        activeState = await runtime.updateRecentMessageState(activeState);
      }
      activeState.username = username;
      activeState.platform = platform;
      activeState.timestamp = new Date().toISOString();

      // Get or generate profile
      const userProfile = userProfileData.find(p => p.latestProfile)?.latestProfile;
      
      let profileData: ProfileData;
      let idealEmbedding: number[];
      
      if (!userProfile || !userProfile.ideal_embedding) {
        // Generate new profile if none exists or if no embeddings
        DataBaristaLogger.info("No profile with embeddings found, generating one now...");
        const combinedProfile = await generateCombinedProfile(runtime, userProfileData, activeState);
        
        if (!combinedProfile) {
        callback({
            text: "I'm having trouble understanding your profile right now. Let's talk more so I can get a better picture of what you're looking for." 
        });
        return false;
      }
      
        // Store the new profile and get embeddings in one operation
        const storeResult = await storeProfile(
          runtime, 
          platform, 
          username, 
          combinedProfile
        );
        
        if (!storeResult) {
        callback({ 
            text: "I'm having trouble updating your profile right now. Please try again in a moment."
          });
          return false;
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
      
      DataBaristaLogger.info(`Using embedding with ${idealEmbedding.length} dimensions for search`);
      
      // Find matches using vector search
      const candidates = await findMatchingProfilesWithAtlasSearch(
        runtime, 
        idealEmbedding, 
        platform, 
        username, 
        activeState
      );
      
        if (!candidates.length) {
        callback({ text: "I've searched my network but couldn't find any matches for you yet. I'll keep looking!" });
          return true;
        }
      
      // Record the match request for rate limiting
      await recordMatchRequest(runtime, platform, username);
  
      // Get the updated match limit after recording the request
      const updatedMatchLimit = await checkMatchLimit(runtime, platform, username);
  
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
        
        // Use the updated remaining count that accounts for the request we just recorded
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
      DataBaristaLogger.error("Error in serendipity handler:", error);
      callback({ text: "I encountered an error while processing your request. Please try again later." });
        return false;
      }
    },
  
    examples: [
    [
      {
        user: "DataBarista",
        content: {
          "text": "I'll search my network for connections that match your interests! (SERENDIPITY)",
          "action": "(SERENDIPITY)"
        },
      }
    ],
    [
      {
        "user": "DataBarista",
        "content": {
          "text": "Would you like me to find you a match from my network? (SERENDIPITY)",
          "action": "(SERENDIPITY)"
        }
      },
      {
        "user": "{{user2}}",
        "content": {
          "text": "Yes please!"
        }
      },
      {
        "user": "DataBarista",
        "content": {
          "text": "Great! Let me search my network for someone who matches your interests.",
          "action": "(SERENDIPITY)"
        }
      }
    ]
    ] as ActionExample[][]
};
  