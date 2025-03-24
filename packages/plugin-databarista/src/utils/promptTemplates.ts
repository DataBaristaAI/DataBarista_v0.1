/**
 * Shared prompt templates used across DataBarista actions
 */

/**
 * Template for generating social media posts for matches
 */
export const MATCH_PROMPT_TEMPLATE = `
MATCHMAKING SOCIAL POST GENERATION TASK

User Profile Data:
{{userProfileData}}

Potential Match Data:
{{matchesData}}

Task:
From the above data, choose the best match that is mutual for both user and the potentialmatch, benefiting mutually from an overlapping opportunity. Make sure the selected match fits the user's goals, especially if someone is searching for someone to have technical collaborations, that the match has the knowledge and skills to help the user.
IMPORTANT: Never select the user's own profile as a match. If the user's profile appears in the potential matches, ignore it and select a different match. If a match works at a similar company with the user, do not select it, since they might already know each other.

Generate a friendly social media post that introduces the user and the best match together.
The post should:
1. Use the proper @username for both user and the best match chosen
2. Highlight their synergy and potential opportunity for collaboration, highlight how they can help each other in each other's challenges
3. Do not use hashtags

Return an array containing a single object with the following structure:

Example Output:
[{
  "post": "DataBarista here, serving you a double shot of innovation ☕️ @amirmabhout, meet @test_fitnessguy! @amirmabhout is designing a cutting-edge AI fitness coach, while @test_fitnessguy has a solid track record marketing innovative fitness products to a tech-enthused crowd. Together, your blend of smart design and strategic promotion has the potential to revolutionize how people engage with fitness technology. Let's see what groundbreaking ideas you can brew up!",
  "matchUsername": "test_fitnessguy",
  "matchPlatform": "telegram"
}]

IMPORTANT: You must include the exact matchUsername and matchPlatform fields with the values from the chosen match so the system knows which match was selected.

Do not include any additional text or explanation outside of the array structure.
`;

/**
 * Template for generating SPARQL queries to find matching profiles
 */
export const MATCH_QUERY_TEMPLATE = `
You are a SPARQL query generator. Your task is to output a JSON array containing one object with a single property "query" whose value is a valid SPARQL query string.
Do not output any additional text or explanation.

SHACL Shape Reference:
{{shaclShapes}}

User Profile Data:
{{userProfileData}}

Recent Messages:
{{recentMessages}}

Task:
Generate a SPARQL query that finds potential matching profiles in the Decentralized Knowledge Graph (DKG) based on both the user profile and recent messages. The query must:

1. **IMPORTANT: Exclude the User's OWN Profile:**  
   You MUST filter out any ?person that has a datalatte:hasAccount with both:  
   - datalatte:accountPlatform equal to "{{platform}}" (e.g. "telegram")  
   - datalatte:accountUsername that matches "{{username}}" (case-insensitive)
   This is critical to prevent the user from being matched with themselves.

2. **Restrict to Same Account Platform:**  
   Only consider profiles where their datalatte:hasAccount has datalatte:accountPlatform equal to "{{platform}}".

3. **Dynamic Multiple-Keyword Filtering:**  
   Dynamically derive multiple keywords (at least two or three per field) from the user's profile and conversation context. For example:
   - For datalatte:knowledgeDomain: derive keywords from the user's "knowledgeDomain" (e.g. "Artificial Intelligence", "AI", "Machine Learning")
   - For datalatte:background: derive keywords from the user's "background" (e.g. "matchmaking", "ai agent", "feedback")
   - For datalatte:desiredConnections (bound as ?allDesiredConnections): derive keywords from the user's role or desired partner traits (e.g. "ai enthusiasts", "developer", "researcher")
   - For the project's domain (?projectDomain): derive keywords from the user's project domain (e.g. "Artificial Intelligence", "Machine Learning", "tech")

4. **Candidate Matching:**  
   Look for candidates where any of the following OPTIONAL fields (case-insensitive, using COALESCE to default missing values to an empty string) contain **at least one** of the derived keywords:
   - datalatte:knowledgeDomain
   - datalatte:background
   - datalatte:desiredConnections (bound as ?allDesiredConnections)
   - datalatte:projectDomain from the related project

5. **Result Ordering and Limiting:**  
   Order results by the most recent intent timestamp and limit the results to 15.

6. **Select Clause:**  
   Ensure the SELECT clause returns:
   - ?person, ?accountUsername (as username), ?knowledgeDomain, ?background, ?allDesiredConnections, ?projectDomain, ?projectType, ?challenge, ?intentTimestamp, ?projectName, and ?projectDescription.

**Dynamic Filtering Section:**  
Construct the FILTER clause so that it checks if any candidate field (after applying COALESCE and LCASE) matches a regex pattern containing one or more of the derived keywords. Replace the placeholder keywords below with the actual values:
- For datalatte:knowledgeDomain: "{{kKeyword1}}", "{{kKeyword2}}", "{{kKeyword3}}"
- For datalatte:background: "{{bKeyword1}}", "{{bKeyword2}}", "{{bKeyword3}}"
- For datalatte:desiredConnections: "{{dKeyword1}}", "{{dKeyword2}}", "{{dKeyword3}}"
- For datalatte:projectDomain: "{{pKeyword1}}", "{{pKeyword2}}", "{{pKeyword3}}"

**Example Output:**
[{
  "query": "PREFIX schema: <http://schema.org/> PREFIX datalatte: <https://datalatte.com/ns/> PREFIX foaf: <http://xmlns.com/foaf/0.1/> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> SELECT DISTINCT ?person ?accountUsername ?knowledgeDomain ?background ?allDesiredConnections ?projectDomain ?projectType ?challenge ?intentTimestamp ?projectName ?projectDescription WHERE { { SELECT ?person (MAX(?ts) AS ?intentTimestamp) { ?person datalatte:hasIntent/datalatte:revisionTimestamp ?ts . } GROUP BY ?person } ?person a foaf:Person ; datalatte:hasAccount ?account . ?account datalatte:accountUsername ?accountUsername ; datalatte:accountPlatform ?accountPlatform . FILTER( LCASE(STR(?accountPlatform)) = LCASE(\"{{platform}}\") ) OPTIONAL { ?person datalatte:knowledgeDomain ?knowledgeDomain. } OPTIONAL { ?person datalatte:background ?background. } OPTIONAL { ?person datalatte:hasIntent ?intent. OPTIONAL { ?intent datalatte:desiredConnections ?allDesiredConnections ; datalatte:challenge ?challenge ; datalatte:relatedTo ?project . OPTIONAL { ?project datalatte:type ?projectType. } OPTIONAL { ?project datalatte:projectDomain ?projectDomain. } OPTIONAL { ?project foaf:name ?projectName. } OPTIONAL { ?project schema:description ?projectDescription. } } } FILTER NOT EXISTS { ?person datalatte:hasAccount ?userAccount . ?userAccount datalatte:accountPlatform \"{{platform}}\" ; datalatte:accountUsername ?userName . FILTER( LCASE(STR(?userName)) = LCASE(\"{{username}}\") ) } FILTER ( regex(LCASE(COALESCE(STR(?knowledgeDomain), \"\")), \"{{kKeyword1}}|{{kKeyword2}}|{{kKeyword3}}\") || regex(LCASE(COALESCE(STR(?background), \"\")), \"{{bKeyword1}}|{{bKeyword2}}|{{bKeyword3}}\") || regex(LCASE(COALESCE(STR(?allDesiredConnections), \"\")), \"{{dKeyword1}}|{{dKeyword2}}|{{dKeyword3}}\") || regex(LCASE(COALESCE(STR(?projectDomain), \"\")), \"{{pKeyword1}}|{{pKeyword2}}|{{pKeyword3}}\") ) } ORDER BY DESC(?intentTimestamp) LIMIT 15"
}]
`;

/**
 * Template for generating ideal match profiles for vector search
 */
export const IDEAL_MATCH_TEMPLATE = `
You are an AI matchmaker assistant specialized in understanding user intents and generating an optimized description of their ideal match.

User Profile:
{{userProfileData}}

Task:
Based on the user's profile and goals data, generate a detailed text description of the IDEAL match for this user. This description will be used directly for vector similarity search to find matching profiles.

Focus on describing someone who would:
1. Have knowledge domains that complement the user's needs
2. Possess skills and experience relevant to the user's goals
3. Work in project domains aligned with what the user is looking for
4. Exhibit any specific traits mentioned by the user as desirable qualities

Create a coherent, detailed paragraph (250-500 words) that thoroughly describes this ideal match. Include specific details about their:
- Professional background and expertise
- Skills and capabilities
- Knowledge domains and specializations
- Project types and experience
- Desired connections the ideal match seeks

The text should be rich in relevant keywords that would help in semantic matching but remain natural-sounding.

Return an array containing a single object with the following structure:

Example Output:
[{
  "ideal_match_description": "The ideal match for this user would be a marketing professional with 5+ years of experience specializing in AI product promotion and community growth strategies. They should have deep expertise in digital marketing, growth hacking, and social media campaign management specifically for technology startups. Ideally, they would understand the AI agent ecosystem and have experience helping AI-based products reach their target audiences through effective go-to-market strategies. They should be familiar with both B2B and B2C marketing approaches for cutting-edge technology, and possess strong analytical skills to measure campaign effectiveness. The ideal match would have experience in building engaged communities around technical products and understand how to communicate complex technical concepts to different audiences. They would be passionate about emerging technologies and have connections to media outlets, technology influencers, and potential partners or investors in the AI space. They should be creative, strategic, and able to work in fast-paced startup environments while providing structured marketing guidance. Knowledge of Web3 would be beneficial but not required. This person should be collaborative, proactive in suggesting ideas, and genuinely interested in helping innovative AI products succeed in the market."
}]

Do not include any additional text or explanation outside of the array structure.
`;

/**
 * Template for extracting knowledge graph data from conversations
 */
export const KG_EXTRACTION_TEMPLATE = `
TASK: Transform conversation data into valid schema.org/FOAF compliant JSON-LD for professional intentions, considering existing intentions in DKG

Recent Messages:
{{recentMessages}}

Existing knowledge related to the person:
{{userProfileData}}
username: {{username}}
platform: {{platform}}

SHACL Shapes for Validation:
{{shaclShapes}}

Guidelines:
1. First analyze if the intent and project from conversation matches or updates any existing intention and project:
   - If exact match exists (same core intention, no new details) -> return empty array
   - If similar intent/project exists but has new details -> use existing intention/project ID and merge details
   - If completely new intention/project -> use the provided new ID
2. For existing updates:
   - Keep all existing fields in the output
   - Add or update fields that have new information
   - Use the exact ID from the matching existing knowledge asset
3. For new intents and projects:
   - Use the provided new ID
   - Fill all fields that can be extracted from conversation
4. All fields must match their defined datatypes and value constraints

Format response as array:
[
  {
    "analysis": {
      "matchType": "exact_match" | "update_existing" | "new_information",
      "existingIntentionId": "<id of matching intention if update_existing>",
      "existingProjectId": "<id of matching project if update_existing>",
      "reason": "<explanation of the decision>"
    },
    "public": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/"
      },
      "@type": "datalatte:Intent",
      "@id": "urn:intent:{{intentid}}",
      "datalatte:revisionTimestamp": "{{timestamp}}",
      "datalatte:summary": "<Anonymized summary of what the user seeks, e.g., 'Seeking a marketing expert to scale digital outreach'>",
      "datalatte:desiredConnections": [
        "<expertise type1>",
        "<expertise type2>"
      ],
      "datalatte:projectDescription": "<Public description of the project, anonymized>",
      "datalatte:challenge": "<Summary of the challenge or goal user seeks>",
      "schema:url": "<Extracted URL if mentioned>",
      "datalatte:intentCategory": "professional",
      "datalatte:relatedTo": "urn:project:{{projectid}}"
    },
    "private": {
      "@context": {
        "schema": "http://schema.org/",
        "datalatte": "https://datalatte.com/ns/",
        "foaf": "http://xmlns.com/foaf/0.1/"
      },
      "@type": "foaf:Person",
      "@id": "urn:uuid:{{uuid}}",
      "datalatte:revisionTimestamp": "{{timestamp}}",
      "datalatte:hasAccount": {
        "@type": "datalatte:Account",
        "datalatte:accountPlatform": "{{platform}}",
        "datalatte:accountUsername": "{{username}}"
      },
      "datalatte:background": "<Private biography or contextual background (e.g., 'Founder of an AI analytics startup')>",
      "datalatte:knowledgeDomain": "<Primary field, e.g., 'Web3', 'DeFi', 'NFT'>",
      "datalatte:privateDetails": "<Any additional sensitive details>",
      "datalatte:hasIntent": {
        "@type": "datalatte:Intent",
        "@id": "urn:intent:{{intentid}}",
      },
      "datalatte:hasProject": {
        "@type": "datalatte:Project",
        "@id": "urn:project:{{projectid}}",
        "datalatte:revisionTimestamp": "{{timestamp}}",
        "foaf:name": "<Project title, e.g., 'NFT Art Marketplace'>",
        "schema:description": "<Project description summary>",
        "datalatte:type": "<Classification, e.g., 'marketplace', 'protocol', 'DAO tool', 'game', 'platform'>",
        "datalatte:projectDomain": "<Project domain, e.g., 'Web3', 'blockchain', 'metaverse'>",
        "datalatte:techStack": "<Technical details or technology stack used>"
      }
    }
  }
]

- If nothing new is found or conversation does not reveal any information that can be extracted in this template, return []
- If updating existing intent or project, use that intention's ID instead of {{intentid}} as well as existing project's ID instead of {{projectid}}
- Exclude any field from the output if not found in conversation
`;

/**
 * Combined template for generating all three profile components: private, public, and ideal match
 * This template creates more semantically rich text profiles for better vector search
 */
export const COMBINED_PROFILE_TEMPLATE = `
TASK: Convert conversation history into semantically rich text-based profile sections

Recent Messages:
{{recentMessages}}

Existing knowledge related to the person:
{{userProfileData}}
username: {{username}}
platform: {{platform}}


Guidelines:
1. First analyze if the intent from conversation matches or updates any existing information
   - If exact match exists (same core intention, no new details) -> enhance existing data but maintain the core meaning
   - If there are new relevant details -> incorporate them in all appropriate sections
2. Create three distinct text sections, each focused on a specific aspect of the profile:

a) PRIVATE SECTION:
Create a comprehensive text (100-250 words) about the user's background, expertise, and personal context.
This section should cover:
- Professional background and career history
- Education and training
- Skills and expertise areas
- Technical capabilities and domain knowledge
- Notable achievements
- Personal context relevant to their professional life
- Experiences and lessons learned
- Strengths and capabilities

b) PUBLIC SECTION:
Create a detailed text (100-250 words) about the user's networking goals and preferences.
This section should cover:
- Current professional goals and intentions
- Projects they're working on or planning
- Challenges they're facing
- Type of help or collaboration they're seeking
- Specific preferences for networking connections
- How they prefer to collaborate
- What they hope to achieve through networking
- Value they offer to potential connections

c) IDEAL MATCH SECTION:
Create a detailed text (200-350 words) describing the ideal match for this user.
This section should cover TWO key aspects:
1. The background, expertise, and capabilities of their ideal match:
   - Professional background and expertise level
   - Knowledge domains and specializations
   - Skills and technical capabilities
   - Experience types and industry background
   - Perspective and approach to work

2. The goals and preferences of the ideal match that would complement the user:
   - Professional goals that align with the user's needs
   - Project interests that overlap with the user's domain
   - Collaborative style that works well with the user
   - Values and priorities that complement the user's approach
   - What they might be looking for that the user can provide

FORMAT RESPONSE AS ARRAY:
[
  {
    "analysis": {
      "matchType": "exact_match" | "update_existing" | "new_information",
      "reason": "<explanation of the decision>"
    },
    "private": "An engineer focused on developing ...",
    "public": "Primary goal is to connect with community builders....",
    "ideal": "A community builder with a strong background ..... and has primary goal ....."
  }
]

Make all three sections semantically rich with domain-specific terminology and details, as they will be used for vector similarity search.
Each section should read as a coherent, standalone text that thoroughly explores its focus area.
Do not include formatting like bullet points or section headers - use natural paragraphs.
If there isn't enough information in the conversation for any section, create the best possible representation based on available context.
`; 