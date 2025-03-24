import { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { getProfile } from "../utils/profileUtils";
import { mongoDbManager } from "../utils/mongoDbManager";
import { DataBaristaLogger } from "../utils/loggingUtils";
import { dataCache } from "../utils/cacheUtils";

/**
 * Creates an initial minimal profile for a new user
 * Stores only essential user identification fields for faster performance
 */
async function createInitialUserProfile(
  runtime: IAgentRuntime,
  platform: string,
  username: string,
  telegramChatId?: string,
  state?: State
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
    
    // Get agent details from runtime
    const agentId = runtime.agentId;
    
    // Get the bot username
    let agentUsername = runtime.character?.username || runtime.character?.name;
    
    // Try to get the actual bot username from Telegram client if available
    const telegramClient = runtime.clients['telegram'] as any;
    if (telegramClient?.bot?.botInfo?.username) {
      agentUsername = telegramClient.bot.botInfo.username.replace(/^@/, '');
      DataBaristaLogger.info(`Using actual bot username for profile: ${agentUsername}`);
    }
    
    // Get community info - defaults to agent username if not available
    const community = state?.community || agentUsername;
    
    // Get MongoDB collection from the connection pool
    const startTime = Date.now();
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    DataBaristaLogger.info(`MongoDB collection obtained for creating initial profile in ${Date.now() - startTime}ms`);
    
    // Find existing document for this user
    const existingDoc = await collection.findOne({ platform, username });
    
    // Only create a new profile if none exists
    if (!existingDoc) {
      // Create a new profile document with minimal initial data
      const profileDocument = {
        platform,
        username,
        created: new Date(),
        lastUpdated: new Date(),
        agentId,
        agentUsername,
        community,
        ...(telegramChatId ? { telegramChatId } : {})
      };
      
      await collection.insertOne(profileDocument);
      
      DataBaristaLogger.info(`Created initial profile for ${username} on ${platform}`);
      return true;
    }
    
    // Profile already exists
    DataBaristaLogger.info(`Profile already exists for ${username} on ${platform}, skipping creation`);
    return false;
  } catch (error) {
    DataBaristaLogger.error(`Error creating initial profile for ${username} on ${platform}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Updates the telegramChatId and agentUsername if they've changed
 * This ensures notifications can be delivered even if the user changes chats or interacts with a different bot
 */
async function updateUserConnectionInfo(
  runtime: IAgentRuntime,
  platform: string,
  username: string,
  telegramChatId?: string,
  agentUsername?: string
): Promise<boolean> {
  if (platform !== 'telegram' || !telegramChatId || !agentUsername) {
    return false; // Only proceed for Telegram with valid data
  }
  
  try {
    // Get MongoDB connection info
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
    const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
    
    if (!connectionString || !dbName) {
      DataBaristaLogger.error('Missing MongoDB connection settings');
      return false;
    }
    
    // Get MongoDB collection from the connection pool
    const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
    
    // Find existing document for this user
    const existingDoc = await collection.findOne({ platform, username });
    
    if (!existingDoc) {
      return false; // No existing profile to update
    }
    
    // Check if chatId or agentUsername have changed
    const needsUpdate = (
      existingDoc.telegramChatId !== telegramChatId || 
      existingDoc.agentUsername !== agentUsername
    );
    
    if (needsUpdate) {
      DataBaristaLogger.info(`Updating connection info for ${username}:`, {
        oldChatId: existingDoc.telegramChatId,
        newChatId: telegramChatId,
        oldAgentUsername: existingDoc.agentUsername,
        newAgentUsername: agentUsername
      });
      
      // Update the connection info
      await collection.updateOne(
        { platform, username },
        {
          $set: {
            telegramChatId,
            agentUsername,
            lastUpdated: new Date()
          }
        }
      );
      
      // Clear the cache to ensure fresh data is loaded next time
      const cacheKey = `profile:${platform}:${username}`;
      dataCache.delete(cacheKey);
      
      return true;
    }
    
    return false; // No update needed
  } catch (error) {
    DataBaristaLogger.error(`Error updating connection info for ${username}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Format user profile data for agent context
 * Only includes essential text fields for better performance
 */
function formatProfileForContext(userData: any[]): string {
  if (!userData || userData.length === 0) {
    return "No profile information available yet.";
  }
  
  const latestProfile = userData[0]?.latestProfile;
  
  if (!latestProfile) {
    return "Profile exists but no details available yet.";
  }
  
  // Only include essential text fields, exclude embeddings
  const profileData = {
    private: latestProfile.private || "",
    public: latestProfile.public || "",
    ideal: latestProfile.ideal || ""
  };
  
  return JSON.stringify(profileData, null, 2);
}

const userProfileProvider: Provider = {
  get: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<string | null> => {
    try {
      // Initialize the logger with the current runtime
      DataBaristaLogger.initialize(runtime);
      
      // Get username from actorsData if available, otherwise fall back to userId
      const username = state?.actorsData?.find(actor => actor.id === message.userId)?.username || message.userId;
      
      // Get platform type from client
      const platform = Object.keys(runtime.clients)[0];

      DataBaristaLogger.info("Retrieving user profile:", { username, platform });

      // Get Telegram chat ID if available
      let telegramChatId: string | undefined;
      let agentUsername: string | undefined;
      
      if (platform === 'telegram') {
        const telegramClient = runtime.clients['telegram'] as any;
        
        // Get current bot username
        agentUsername = telegramClient?.bot?.botInfo?.username?.replace(/^@/, '') || 
                       runtime.character?.username || 
                       runtime.character?.name;
        
        // Try to get chat ID from different sources
        if ((message as any).content?.chatId) {
          telegramChatId = (message as any).content.chatId;
        } else if (telegramClient?.messageManager?.getUserChatId) {
          telegramChatId = telegramClient.messageManager.getUserChatId(username);
        }
        
        if (telegramChatId && agentUsername) {
          DataBaristaLogger.debug(`Current connection info for ${username}: chatId=${telegramChatId}, agentUsername=${agentUsername}`);
        }
      }

      // Get profile using the profileUtils.getProfile function
      // This already utilizes the caching mechanism from dataCache
      let userData = await getProfile(runtime, platform, username);

      // If no data found, create an initial profile
      if (!userData || userData.length === 0) {
        DataBaristaLogger.info(`No profile found for ${username}, creating initial profile`);
        
        // Create initial profile with minimal data
        await createInitialUserProfile(runtime, platform, username, telegramChatId, state);
        
        // Get the freshly created profile
        userData = await getProfile(runtime, platform, username);
        
        // Still no profile data (creation might have failed)
        if (!userData || userData.length === 0) {
          return `No profile information found yet for @${username}. Continuing conversation to learn more about user's needs and interests.`;
        }
      } else if (platform === 'telegram' && telegramChatId && agentUsername) {
        // Check if we need to update the connection info
        const existingProfile = userData[0];
        
        if (existingProfile.telegramChatId !== telegramChatId || 
            existingProfile.agentUsername !== agentUsername) {
          
          // Connection info needs to be updated
          await updateUserConnectionInfo(runtime, platform, username, telegramChatId, agentUsername);
          
          // Log the update
          DataBaristaLogger.info(`Updated connection info for ${username}:`, {
            oldChatId: existingProfile.telegramChatId,
            newChatId: telegramChatId,
            oldAgentUsername: existingProfile.agentUsername,
            newAgentUsername: agentUsername
          });
          
          // Refresh profile data
          userData = await getProfile(runtime, platform, username);
        }
      }

      // Format profile for context
      const formattedProfile = formatProfileForContext(userData);

      return `
Profile for @${username}:
\`\`\`json
${formattedProfile}
\`\`\`
Task: Based on the profile and recent conversation, engage naturally to gather more information about the user's interests and what connections they're seeking. Focus on understanding their professional background, current projects, and the type of people they want to connect with.
`;
    } catch (error) {
      DataBaristaLogger.error("Error in userProfileProvider:", error);
      return "Error retrieving user profile. Continuing conversation normally.";
    }
  }
};

export { userProfileProvider }; 