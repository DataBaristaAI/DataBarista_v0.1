import {
  IAgentRuntime,
  Memory,
  State,
  elizaLogger,
  ModelClass,
  composeContext,
  generateObjectArray,
  embed,
  type HandlerCallback
} from "@elizaos/core";
import { MongoClient, Document } from 'mongodb';
import { COMBINED_PROFILE_TEMPLATE } from "./promptTemplates";
import { SHACL_SHAPES } from "./shaclShapes";
import { DAILY_MATCH_LIMIT, DEFAULT_VECTOR_INDEX_NAME, MONGODB_VECTOR_INDEX_ENV_VAR } from "./constants";
import { mongoDbManager } from "./mongoDbManager";
import { dataCache } from "./cacheUtils";
import { DataBaristaLogger } from "./loggingUtils";

/**
 * Interface for match request record
 */
interface MatchRequest {
  timestamp: Date;
  count: number;
}

/**
 * Interface for match history record
 */
interface MatchRecord {
  platform: string;
  username: string;
  timestamp: Date;
}

/**
 * Interface for profile data returned from MongoDB CKG
 */
interface ProfileData {
  platform: string;
  username: string;
  latestProfile: {
    public: any;
    private: any;
    ideal?: string;
    timestamp?: Date;
    embedding?: number[];
    ideal_embedding?: number[];
  };
  timestamp?: Date;
  lastUpdated?: Date;
  // Match history to avoid repetitive matches
  matchHistory?: MatchRecord[];
  // Match request timestamps for rate limiting
  matchRequests?: MatchRequest[];
  // Store original Telegram chat ID for sending notifications
  telegramChatId?: string;
  agentUsername?: string;
}

interface TelegramMessageManager {
  interestChats: {
    [key: string]: {
      messages: Array<{
        userName: string;
        chatId?: string;
      }>;
    };
  };
  getUserChatId?: (username: string) => string | undefined;
  getAllUserChatIds?: () => Record<string, string>;
}

interface TelegramClient {
  messageManager: TelegramMessageManager;
  bot: {
    telegram: {
      sendMessage(chatId: string, message: string): Promise<any>;
    };
  };
}

/**
 * Generates an ideal match profile description based on user profile data
 * This is a compatibility function that uses the new generateCombinedProfile
 * and returns just the ideal section
 * 
 * @param runtime Agent runtime
 * @param userProfileData User profile data
 * @param state Current state
 * @returns Ideal match description or null if generation fails
 */
export async function generateIdealMatchProfile(
  runtime: IAgentRuntime,
  userProfileData: any,
  state?: State
): Promise<string | null> {
  try {
    DataBaristaLogger.debug('Generating ideal match profile using combined profile generator');
    
    // Use the new combined profile generator
    const combinedProfile = await generateCombinedProfile(runtime, userProfileData, state);
    
    if (!combinedProfile) {
      DataBaristaLogger.error("Failed to generate combined profile for ideal match");
      return null;
    }
    
    // Return just the ideal section
    return combinedProfile.ideal;
  } catch (error) {
    DataBaristaLogger.error(`Error generating ideal match profile: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Generate embeddings for profile data using ElizaOS Core's embedding service
 * This is a compatibility function that supports the old format for backward compatibility
 * It will attempt to use the new generateCombinedProfileEmbeddings when possible
 * 
 * @param runtime Agent runtime for embedding service 
 * @param profileData Profile data to generate embeddings for (either a complex object or an object with ideal_match_description)
 * @returns Embedding vector as number array
 */
export async function generateProfileEmbedding(
  runtime: IAgentRuntime,
  profileData: any
): Promise<number[] | null> {
  try {
    // Check if we have a simple ideal match description
    if (profileData.ideal_match_description) {
      // If we have a direct description text, use it directly
      return await embed(runtime, profileData.ideal_match_description);
    }
    
    // Check if we have a text-based profile structure
    if (profileData.private && profileData.public && profileData.ideal &&
        typeof profileData.private === 'string' && 
        typeof profileData.public === 'string' && 
        typeof profileData.ideal === 'string') {
      
      // Use the new combined profile embeddings function
      const embeddings = await generateCombinedProfileEmbeddings(runtime, profileData);
      if (embeddings) {
        // Return the ideal embedding since that's what the old function would return
        return embeddings.ideal_embedding;
      }
      return null;
    }
    
    // Handle legacy format - extract text from the JSON-LD structure
    let textToEmbed = '';
    
    // Extract from complex profile structure
    const publicData = profileData.public || {};
    const privateData = profileData.private || {};
    
    // Combine the most important semantic fields for embedding
    textToEmbed = [
      publicData["datalatte:summary"] || "",
      publicData["datalatte:intentCategory"] || "",
      publicData["datalatte:projectDescription"] || "",
      privateData["datalatte:background"] || "",
      privateData["datalatte:knowledgeDomain"] || "",
      privateData?.["datalatte:hasProject"]?.["datalatte:projectDomain"] || "",
      privateData?.["datalatte:hasProject"]?.["schema:description"] || "",
      // Join desired connections if it's an array
      Array.isArray(publicData["datalatte:desiredConnections"]) 
        ? publicData["datalatte:desiredConnections"].join(" ") 
        : (publicData["datalatte:desiredConnections"] || "")
    ].filter(Boolean).join(" ");
    
    if (!textToEmbed.trim()) {
      DataBaristaLogger.warn("No meaningful text found to embed for profile");
      return null;
    }
    
    // Use ElizaOS Core embedding service
    return await embed(runtime, textToEmbed);
  } catch (error) {
    DataBaristaLogger.error("Error generating profile embedding:", error);
    return null;
  }
}

/**
 * Find matching profiles using vector similarity search
 * 
 * @param runtime Agent runtime
 * @param idealProfileEmbedding Embedding vector for ideal match profile
 * @param platform Platform to search in (e.g., "telegram")
 * @param username Username to exclude from results
 * @param state Current state or bot username
 * @returns Array of matching profiles
 */
export async function findMatchingProfilesWithAtlasSearch(
  runtime: IAgentRuntime,
  idealProfileEmbedding: number[],
  platform: string,
  username: string,
  state?: State | string
): Promise<any[]> {
  try {
    // Get MongoDB connection info
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    // Validate connection info
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return [];
    }
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for Atlas search in ${Date.now() - startTime}ms`);
    
    // Get bot username to filter users from the same community
    const myBotUsername = typeof state === 'string' 
      ? state 
      : (state?.agentUsername || runtime.character?.username);
    
    // Query exclude list (excludes self and recently matched profiles)
    const excludeList = [
      { platform, username }, // Exclude self
    ];
    
    // Add the user's match history to the exclude list if available
    try {
      const userDoc = await collection.findOne({ platform, username });
      if (userDoc?.matchHistory) {
        // Add matches from the last 30 days to the exclude list
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const recentMatches = userDoc.matchHistory.filter((match: any) => 
          new Date(match.timestamp) > thirtyDaysAgo
        );
        
        excludeList.push(...recentMatches);
      }
    } catch (error) {
      DataBaristaLogger.warn("Error fetching match history:", error);
      // Continue with search even if we can't get match history
    }
    
    // Get vector index name from environment
    const vectorIndexName = runtime.getSetting('MONGODB_VECTOR_INDEX') || 'text_embedding_index';
    DataBaristaLogger.info(`Using vector index name: ${vectorIndexName}`);
    
    // Define the search pipeline
    const pipeline = [
      {
        // Search against embedding (renamed from profile_embedding) in the latestProfile
        $vectorSearch: {
          index: vectorIndexName,
          path: "latestProfile.embedding",
          queryVector: idealProfileEmbedding,
          numCandidates: 100,
          limit: 10
        }
      },
      {
        $match: {
          $nor: excludeList.map(item => ({
            platform: item.platform,
            username: item.username
          }))
        }
      },
      {
        $project: {
          platform: 1,
          username: 1,
          "latestProfile.private": 1,
          "latestProfile.public": 1,
          "latestProfile.ideal": 1,
          "latestProfile.timestamp": 1,
          timestamp: 1,
          lastUpdated: 1,
          telegramChatId: 1,
          score: { $meta: "vectorSearchScore" }
        }
      },
      {
        $limit: 7 // Limit to top 7 matches after filtering
      }
    ];
    
    const matches = await collection.aggregate(pipeline).toArray();
    
    // Format the results to match the expected structure
    const result = matches.map(match => ({
      platform: match.platform,
      username: match.username,
      profileData: match.latestProfile,
      timestamp: match.timestamp || match.lastUpdated || new Date(),
      score: match.score,
      telegramChatId: match.telegramChatId
    }));
    
    return result;
  } catch (error) {
    DataBaristaLogger.error("Atlas search failed:", error);
    return [];
  }
}

/**
 * Send a notification to a matched user
 * @param runtime Agent runtime
 * @param platform Platform of the matched user
 * @param matchedUsername Username of the matched user
 * @param username Username of the requesting user
 * @param postMessage The message to send to the matched user
 * @param callback Optional callback function for direct messaging
 * @returns Boolean indicating success
 */
export async function notifyMatchedUser(
  runtime: IAgentRuntime,
  platform: string,
  matchedUsername: string,
  username: string,
  postMessage: string,
  callback?: any
): Promise<boolean> {
  try {
    // Create a personalized message for the matched user
    const matchNotificationMessage = `
Hey @${matchedUsername}! ☕️

${username} just dropped by my café chatting about their latest challenge, and I immediately thought of you. Couldn't resist passing along your contact—hope that's cool! Here's the brew I served up about you:

----------
${postMessage}
----------

Hope you two stir up something amazing together! Thanks a latte! ☕️✨
`;
    
    // Send the notification
    const notificationSent = await sendNotification(
      runtime,
      platform,
      matchedUsername,
      matchNotificationMessage,
      callback
    );
    
    if (notificationSent) {
      DataBaristaLogger.info(`Successfully notified ${matchedUsername} about the match with ${username}`);
    } else {
      DataBaristaLogger.warn(`Failed to notify ${matchedUsername} about the match with ${username}`);
    }
    
    return notificationSent;
  } catch (error) {
    DataBaristaLogger.error(`Error notifying matched user: ${error}`);
    return false;
  }
}

/**
 * Check if a user has reached their match limit
 * 
 * @param runtime Agent runtime
 * @param platform User platform
 * @param username User username
 * @returns Object with isLimited boolean and resetTime
 */
export async function checkMatchLimit(
  runtime: IAgentRuntime,
  platform: string,
  username: string
): Promise<{
  isLimited: boolean;
  remaining?: number;
  resetTime?: Date;
}> {
  try {
    // Get MongoDB connection info
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    // Validate connection info
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return { isLimited: false };
    }
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for match limit check in ${Date.now() - startTime}ms`);
    
    // Find user document
    const userDoc = await collection.findOne({ platform, username });
    
    if (!userDoc) {
      return { isLimited: false, remaining: DAILY_MATCH_LIMIT };
    }
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Filter requests from today only
    const todayRequests = (userDoc.matchRequests || []).filter((req: any) => 
      new Date(req.timestamp) >= today && new Date(req.timestamp) < tomorrow
    );
    
    // Count total requests today
    const totalRequests = todayRequests.reduce((sum: number, req: any) => sum + (req.count || 1), 0);
    
    // Determine if user has reached their limit
    const isLimited = totalRequests >= DAILY_MATCH_LIMIT;
    const remaining = Math.max(0, DAILY_MATCH_LIMIT - totalRequests);
    
    return {
      isLimited,
      remaining,
      resetTime: tomorrow
    };
  } catch (error) {
    DataBaristaLogger.error(`Error checking match limit: ${error}`);
    // Default to not limited if there's an error
    return { isLimited: false };
  }
}

/**
 * Record a match request for rate limiting
 * 
 * @param runtime Agent runtime
 * @param platform User platform
 * @param username User username
 * @returns Boolean indicating success
 */
export async function recordMatchRequest(
  runtime: IAgentRuntime,
  platform: string,
  username: string
): Promise<boolean> {
  try {
    // Get MongoDB connection info
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    // Validate connection info
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return false;
    }
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for recording match request in ${Date.now() - startTime}ms`);
    
    // Current timestamp
    const now = new Date();
    
    // Add match request record with type assertion
    await collection.updateOne(
      { platform, username },
      {
        $push: {
          matchRequests: {
            timestamp: now,
            count: 1
          }
        }
      } as any,
      { upsert: true }
    );
    
    return true;
  } catch (error) {
    DataBaristaLogger.error(`Error recording match request: ${error}`);
    return false;
  }
}

/**
 * Record matches between users
 * 
 * @param runtime Agent runtime
 * @param platform User platform
 * @param username User username
 * @param matches Array of matches to record
 * @returns Boolean indicating success
 */
export async function recordMatches(
  runtime: IAgentRuntime,
  platform: string,
  username: string,
  matches: Array<{
    platform: string;
    username: string;
    timestamp: Date;
  }>
): Promise<boolean> {
  try {
    if (!matches || matches.length === 0) {
      DataBaristaLogger.info(`No matches to record for ${username}`);
      return true;
    }
    
    // Get MongoDB connection info
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    // Validate connection info
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return false;
    }
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for recording matches in ${Date.now() - startTime}ms`);
    
    // Update the user's match history with type assertion
    await collection.updateOne(
      { platform, username },
      {
        $push: {
          matchHistory: {
            $each: matches
          }
        }
      } as any,
      { upsert: true }
    );
    
    // Also record match in the matched users' documents
    for (const match of matches) {
      // Skip if the match doesn't have platform or username
      if (!match.platform || !match.username) continue;
      
      // Record the current user in the matched user's history with type assertion
      await collection.updateOne(
        { platform: match.platform, username: match.username },
        {
          $push: {
            matchHistory: {
              platform,
              username,
              timestamp: match.timestamp
            }
          }
        } as any,
        { upsert: true }
      );
    }
    
    return true;
  } catch (error) {
    DataBaristaLogger.error(`Error recording matches: ${error}`);
    return false;
  }
}

/**
 * Get a user's match history
 * @param runtime Agent runtime
 * @param platform User platform
 * @param username User username
 * @returns Array of previous matches
 */
export async function getMatchHistory(
  runtime: IAgentRuntime,
  platform: string,
  username: string
): Promise<Array<{ platform: string; username: string; timestamp: Date }>> {
  try {
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return [];
    }
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for getting match history in ${Date.now() - startTime}ms`);
    
    const profile = await collection.findOne(
      { platform, username },
      { projection: { matchHistory: 1 } }
    );
    
    return profile?.matchHistory || [];
  } catch (error) {
    DataBaristaLogger.error('Error getting match history:', error);
    return [];
  }
}

/**
 * Send a notification message to a user
 * @param runtime Agent runtime
 * @param platform User platform
 * @param username User username
 * @param message Message to send
 * @param userCallback Optional callback function to use for sending messages
 * @returns Success status
 */
export async function sendNotification(
  runtime: IAgentRuntime,
  platform: string,
  username: string,
  message: string,
  userCallback?: HandlerCallback
): Promise<boolean> {
  try {
    // Only use the chat ID from the CKG database
    if (platform === 'telegram') {
      // Retrieve user profile to get both chat ID and associated agent username
      const userProfile = await getUserProfile(runtime, username);
      
      if (!userProfile) {
        DataBaristaLogger.warn(`No user profile found for user ${username}`);
        return false;
      }
      
      const storedChatId = userProfile.telegramChatId;
      const agentUsername = userProfile.agentUsername;
      
      if (!storedChatId) {
        DataBaristaLogger.warn(`No chat ID found for user ${username}`);
        return false;
      }
      
      try {
        // Get the appropriate Telegram bot token based on the agent username
        const botToken = getTelegramBotToken(runtime, agentUsername);
        
        if (!botToken) {
          DataBaristaLogger.error(`No Telegram bot token configured for agent ${agentUsername}`);
          return false;
        }
        
        // Create a temporary Telegram bot instance with the correct token
        const { Telegraf } = await import('telegraf');
        const tempBot = new Telegraf(botToken);
        
        // Send the message using the temporary bot
        await tempBot.telegram.sendMessage(storedChatId, message);
        DataBaristaLogger.info(`Successfully sent message to ${username} using bot for agent ${agentUsername}`);
        return true;
      } catch (error) {
        DataBaristaLogger.error(`Failed to send Telegram message to ${username}: ${error}`);
        return false;
      }
    }

    return false;
  } catch (error) {
    DataBaristaLogger.error(`Error in sendNotification: ${error}`);
    return false;
  }
}

/**
 * Get the appropriate Telegram bot token based on agent username
 * @param runtime Agent runtime
 * @param agentUsername Agent username associated with the user
 * @returns Telegram bot token
 */
function getTelegramBotToken(runtime: IAgentRuntime, agentUsername?: string): string | undefined {
  // Default to the current runtime's token if no agent username specified
  if (!agentUsername) {
    return runtime.getSetting('TELEGRAM_BOT_TOKEN');
  }
  
  // Get tokens from environment variables based on agent username
  // Format: TELEGRAM_BOT_TOKEN_AGENTNAME (with non-alphanumeric chars removed)
  const safeAgentName = agentUsername.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const tokenEnvKey = `TELEGRAM_BOT_TOKEN_${safeAgentName}`;
  
  // Try to get the specific token for this agent
  const agentSpecificToken = runtime.getSetting(tokenEnvKey);
  
  // Use the specific token if available, otherwise fall back to the default token
  return agentSpecificToken || runtime.getSetting('TELEGRAM_BOT_TOKEN');
}

/**
 * Get the user's profile data
 * @param runtime Agent runtime
 * @param username Username to look up
 * @returns User profile data or null if not found
 */
async function getUserProfile(runtime: IAgentRuntime, username: string): Promise<ProfileData | null> {
  try {
    // Clean the username - ensure no @ prefix for database queries
    const cleanUsername = username.replace(/^@/, '');
    
    // Generate a cache key for this user profile
    const cacheKey = `profile:telegram:${cleanUsername}`;
    
    // Try to get the profile from cache first
    return await dataCache.getOrCompute<ProfileData | null>(
      cacheKey,
      async () => {
        // Cache miss - fetch from database
        const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
        const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
        const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || 'telegram';
        
        if (!connectionString || !dbName) {
          DataBaristaLogger.error('Missing MongoDB connection settings');
          return null;
        }
        
        // Get MongoDB collection from the connection pool
        const startTime = Date.now();
        const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
        DataBaristaLogger.info(`MongoDB collection obtained for getting user profile in ${Date.now() - startTime}ms`);
        
        // Look for the user profile
        const profile = await collection.findOne(
          { platform: 'telegram', username: cleanUsername }
        );
        
        // Cast the MongoDB document to ProfileData type and return
        return profile as unknown as ProfileData;
      },
      // Cache profiles for 10 minutes
      10 * 60 * 1000
    );
  } catch (error) {
    DataBaristaLogger.error(`Error retrieving profile for ${username}:`, error);
    return null;
  }
}

/**
 * Generate combined profile content using the new text-based approach
 * Creates private, public, and ideal match sections in one call
 * 
 * @param runtime Agent runtime
 * @param userProfileData Existing user profile data (can be empty/null for new users)
 * @param state Current state with conversation context
 * @returns Object with private, public, and ideal text sections, or null if generation fails
 */
export async function generateCombinedProfile(
  runtime: IAgentRuntime,
  userProfileData: any,
  state?: State
): Promise<{
  private: string;
  public: string;
  ideal: string;
  analysis: { 
    matchType: 'exact_match' | 'update_existing' | 'new_information';
    reason: string; 
  };
} | null> {
  try {
    DataBaristaLogger.debug('Generating combined profile with all three components');
    
    // Update state with recent messages if not present
    if (state && !state.recentMessages) {
      state = await runtime.updateRecentMessageState(state);
    }

    // Prepare context
    const contextData = {
      shaclShapes: SHACL_SHAPES,
      userProfileData: JSON.stringify(userProfileData || {}, null, 2),
      username: state?.username || '',
      platform: state?.platform || '',
      recentMessages: state?.recentMessages || []
    };
    
    // Log minimal info about profile generation input
    DataBaristaLogger.info(`Generating profile for ${contextData.username} on ${contextData.platform}`);

    const context = composeContext({
      template: COMBINED_PROFILE_TEMPLATE,
      state: contextData as any
    });
    
    // Log raw prompt content
    DataBaristaLogger.info(`RAW_PROFILE_PROMPT: ${context}`);

    const combinedProfileResult = await generateObjectArray({
      runtime,
      context,
      modelClass: ModelClass.LARGE
    });
    
    // Log raw LLM response
    DataBaristaLogger.info(`RAW_PROFILE_RESPONSE: ${JSON.stringify(combinedProfileResult)}`);

    if (!combinedProfileResult?.length) {
      DataBaristaLogger.error("Failed to generate combined profile: empty result");
      return null;
    }

    // Extract the sections from the result
    const result = combinedProfileResult[0];
    
    // Log minimal info about profile generation result
    DataBaristaLogger.info(`Profile generated for ${contextData.username} with match type: ${result.analysis?.matchType || 'unknown'}`);
    
    if (!result.private || !result.public || !result.ideal || !result.analysis) {
      DataBaristaLogger.error("Invalid combined profile format: missing required sections", result);
      return null;
    }
    
    return {
      private: result.private,
      public: result.public,
      ideal: result.ideal,
      analysis: result.analysis
    };
  } catch (error) {
    DataBaristaLogger.error(`Error generating combined profile: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Generate embeddings from the new text-based profile structure
 * Creates two embeddings: one for profile (private+public) and one for ideal match
 * 
 * @param runtime Agent runtime for embedding service
 * @param profileData Object containing private, public, and ideal text sections
 * @returns Object containing profile and ideal match embeddings, or null if generation fails
 */
export async function generateCombinedProfileEmbeddings(
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
    // Combine private and public sections for the profile embedding
    const profileText = `${profileData.private} ${profileData.public}`;
    
    // Generate embedding for the combined profile text
    const profileEmbedding = await embed(runtime, profileText);
    
    // Generate embedding for the ideal match text
    const idealEmbedding = await embed(runtime, profileData.ideal);
    
    if (!profileEmbedding || profileEmbedding.length === 0 || 
        !idealEmbedding || idealEmbedding.length === 0) {
      DataBaristaLogger.warn("Failed to generate one or both embeddings for combined profile");
      return null;
    }
    
    return {
      embedding: profileEmbedding,
      ideal_embedding: idealEmbedding
    };
  } catch (error) {
    DataBaristaLogger.error("Error generating combined profile embeddings:", error);
    return null;
  }
} 