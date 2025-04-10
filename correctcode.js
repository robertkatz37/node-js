// server.js - Main Express application
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');
const { Parser } = require('json2csv');

const app = express();
const PORT = process.env.PORT || 2000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route to handle scraping requests
app.post('/api/scrape', async (req, res) => {
  try {
    const { query, location, limit = 20 } = req.body;
    
    if (!query || !location) {
      return res.status(400).json({ error: 'Query and location are required' });
    }
    
    const searchQuery = `${query} in ${location}`;
    const results = await scrapeGoogleMaps(searchQuery, limit);
    
    res.json({ success: true, data: results });
  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({ error: 'Failed to scrape data', message: error.message });
  }
});

// Route to export data
app.post('/api/export', async (req, res) => {
  try {
    const { data, format } = req.body;
    
    if (!data || !format) {
      return res.status(400).json({ error: 'Data and format are required' });
    }
    
    let exportedData;
    let contentType;
    let filename;
    
    if (format === 'xlsx') {
      exportedData = await exportToExcel(data);
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      filename = 'google_maps_data.xlsx';
    } else if (format === 'csv') {
      exportedData = exportToCSV(data);
      contentType = 'text/csv';
      filename = 'google_maps_data.csv';
    } else if (format === 'json') {
      exportedData = Buffer.from(JSON.stringify(data, null, 2));
      contentType = 'application/json';
      filename = 'google_maps_data.json';
    } else {
      return res.status(400).json({ error: 'Unsupported format' });
    }
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(exportedData);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export data', message: error.message });
  }
});

// Random delay function to mimic human behavior
const randomDelay = async (page, min = 1000, max = 4000) => {
  const delay = Math.floor(Math.random() * (max - min)) + min;
  await page.waitForTimeout(delay);
};

// Main scraping function with improved robustness and error handling
async function scrapeGoogleMaps(searchQuery, limit) {
  const browser = await puppeteer.launch({
    headless: false,  // Change to false for debugging
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
    ]
  });
  
  const page = await browser.newPage();
  
  // Set a realistic user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36');
  
  // Add extra headers to look more like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Referer': 'https://www.google.com/'
  });
  
  try {
    // Enable request interception for better performance
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      // Skip loading images, fonts and stylesheets for better performance
      const resourceType = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`Navigating to Google Maps and searching for: ${searchQuery}`);
    await page.goto('https://www.google.com/maps', { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Accept cookies if the dialog appears
    try {
      const cookieSelectors = [
        'button[aria-label="Accept all"]',
        'button[jsname="higCR"]',
        'button:has-text("Accept all")',
        'button:has-text("I agree")'
      ];
      
      for (const selector of cookieSelectors) {
        const cookieButton = await page.$(selector);
        if (cookieButton) {
          await cookieButton.click();
          console.log('Accepted cookies');
          await page.waitForTimeout(2000);
          break;
        }
      }
    } catch (error) {
      console.log('No cookie consent dialog found or error handling it:', error.message);
    }
    
    // Find and type in the search box
    await page.waitForSelector('#searchboxinput', { timeout: 15000 });
    await page.type('#searchboxinput', searchQuery);
    
    // Add a small delay between typing and pressing Enter to mimic human behavior
    await randomDelay(page, 800, 2000);
    
    await page.keyboard.press('Enter');
    
    // Wait longer for search results to load completely
    console.log('Waiting for search results to load...');
    await page.waitForTimeout(8000);
    
    // Try different selectors for search results container
    const feedSelectors = [
      'div[role="feed"]',
      'div[role="main"] div.m6QErb',
      'div.m6QErb[role="region"]',
      'div.ecceSd',
      'div.section-result-content'
    ];
    
    let feedSelector = null;
    for (const selector of feedSelectors) {
      const feed = await page.$(selector);
      if (feed) {
        feedSelector = selector;
        console.log(`Found search results with selector: ${selector}`);
        break;
      }
    }
    
    if (!feedSelector) {
      console.log('Could not find search results container with known selectors');
      console.log('Taking a screenshot for debugging...');
      await page.screenshot({ path: 'search-results-debug.png' });
    }
    
    // Scroll to load more results until we have the required number of listings
    console.log(`Scrolling to load at least ${limit} results...`);
    
    // Get the initial count of listings
    let listingsCount = await getListingsCount(page);
    console.log(`Initial listings count: ${listingsCount}`);
    
    // Keep scrolling until we have enough listings or can't load more
    let previousCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 20; // Prevent infinite scrolling
    
    while (listingsCount < limit && scrollAttempts < maxScrollAttempts && listingsCount !== previousCount) {
      previousCount = listingsCount;
      await autoScroll(page);
      listingsCount = await getListingsCount(page);
      console.log(`After scrolling: ${listingsCount} listings found`);
      scrollAttempts++;
    }
    
    // Collect basic listing information
    console.log('Collecting basic listing information...');
    const businessListings = await collectListings(page, limit);
    console.log(`Collected ${businessListings.length} listings`);
    
    // For each listing, collect detailed info
    const detailedData = [];
    
    for (let i = 0; i < businessListings.length; i++) {
      try {
        const listing = businessListings[i];
        console.log(`Processing business ${i+1}/${businessListings.length}: ${listing.name}`);
        
        // Always start from the search results page for each listing
        if (i > 0) {
          console.log('Navigating back to search results...');
          await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`, { 
            waitUntil: 'networkidle2',
            timeout: 60000 
          });
          
          // Wait longer to ensure page loads completely
          await page.waitForTimeout(8000);
          
          // Need to scroll to find our place if it's further down
          const scrollsNeeded = Math.floor(i / 3);
          console.log(`Scrolling ${scrollsNeeded} times to reach listing #${i}`);
          
          for (let j = 0; j < scrollsNeeded; j++) {
            await autoScroll(page);
            await page.waitForTimeout(2000);
          }
        }
        
        // Multiple strategies to click on a listing
        let clickSuccess = false;
        
        // Strategy 1: Try clicking using various selectors
        const listingSelectors = [
          `a.hfpxzc[aria-label="${listing.name.replace(/"/g, '\\"')}"]`,
          `a[aria-label="${listing.name.replace(/"/g, '\\"')}"]`,
          `div[aria-label="${listing.name.replace(/"/g, '\\"')}"]`,
          `div.V0h1Ob-haAclf[aria-label="${listing.name.replace(/"/g, '\\"')}"]`,
          `div.Nv2PK[aria-label="${listing.name.replace(/"/g, '\\"')}"]`
        ];
        
        for (const selector of listingSelectors) {
          try {
            console.log(`Trying to click using selector: ${selector}`);
            const listingElement = await page.$(selector);
            if (listingElement) {
              await listingElement.click();
              console.log(`Successfully clicked listing using selector`);
              clickSuccess = true;
              break;
            }
          } catch (err) {
            console.log(`Error clicking with selector: ${err.message}`);
          }
        }
        
        // Strategy 2: Click by index if selectors failed
        if (!clickSuccess) {
          try {
            console.log(`Trying to click listing #${i} by index...`);
            // Try different listing item selectors
            const itemSelectors = [
              'a.hfpxzc',
              'div.Nv2PK',
              'div.V0h1Ob-haAclf',
              'div[role="article"]',
              'a[jsaction*="click"]'
            ];
            
            for (const selector of itemSelectors) {
              clickSuccess = await page.evaluate((selector, index) => {
                const items = document.querySelectorAll(selector);
                console.log(`Found ${items.length} items with selector ${selector}`);
                if (items && items[index]) {
                  items[index].click();
                  return true;
                }
                return false;
              }, selector, i);
              
              if (clickSuccess) {
                console.log(`Successfully clicked listing #${i} with selector ${selector}`);
                break;
              }
            }
          } catch (err) {
            console.log(`Error clicking by index: ${err.message}`);
          }
        }
        
        // Strategy 3: Try JavaScript click by searching text content
        if (!clickSuccess) {
          try {
            console.log('Trying to click by text content match...');
            // This strategy searches for any element containing the business name text
            clickSuccess = await page.evaluate((businessName) => {
              // Get all elements
              const allElements = document.querySelectorAll('*');
              
              // Find one containing our business name
              for (const element of allElements) {
                if (element.textContent && element.textContent.includes(businessName)) {
                  // Find the closest clickable parent
                  let current = element;
                  while (current && current !== document.body) {
                    if (current.tagName === 'A' || current.onclick || current.getAttribute('role') === 'button') {
                      current.click();
                      return true;
                    }
                    current = current.parentElement;
                  }
                  // If no clickable parent, try clicking the element itself
                  element.click();
                  return true;
                }
              }
              return false;
            }, listing.name);
            
            if (clickSuccess) {
              console.log('Successfully clicked listing by text content match');
            }
          } catch (err) {
            console.log(`Error with text content match click: ${err.message}`);
          }
        }
        
        if (!clickSuccess) {
          console.log(`Could not click on listing ${i}, skipping...`);
          continue;
        }
        
        // Wait for details panel to load
        console.log('Waiting for business details to load...');
        await page.waitForTimeout(8000); // Extended wait time
        
        // Take a screenshot for debugging if needed
        // await page.screenshot({ path: `business-${i}.png` });
        
        // Extract detailed info
        console.log('Extracting detailed business information...');
        const detailedInfo = await extractBusinessDetails(page);
        
        // Combine basic and detailed info
        detailedData.push({
          ...listing,
          ...detailedInfo
        });
        
        // Add some delay between businesses
        await randomDelay(page, 2000, 5000);
        
      } catch (error) {
        console.error(`Error processing business ${i+1}:`, error.message);
        continue;
      }
    }
    
    console.log(`Successfully scraped ${detailedData.length} businesses`);
    return detailedData;
  } catch (error) {
    console.error('Error during scraping:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Function to get the number of listings currently loaded with multiple selector attempts
async function getListingsCount(page) {
  return await page.evaluate(() => {
    const selectors = [
      'a.hfpxzc',
      'div.Nv2PK',
      'div.V0h1Ob-haAclf',
      'div[role="article"]',
      'a[jsaction*="click"]'
    ];
    
    for (const selector of selectors) {
      const items = document.querySelectorAll(selector);
      if (items && items.length > 0) {
        return items.length;
      }
    }
    return 0;
  });
}

// Function to collect basic information about each listing with improved selectors
async function collectListings(page, limit) {
  return await page.evaluate((maxResults) => {
    const listings = [];
    const selectors = [
      'a.hfpxzc',
      'div.Nv2PK',
      'div.V0h1Ob-haAclf',
      'div[role="article"]',
      'a[jsaction*="click"]'
    ];
    
    let items = [];
    
    // Try different selectors to find listing elements
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      if (elements && elements.length > 0) {
        items = elements;
        break;
      }
    }
    
    for (let i = 0; i < Math.min(items.length, maxResults); i++) {
      try {
        const item = items[i];
        
        // Try different approaches to get the business name
        let name = null;
        
        // Approach 1: aria-label attribute
        if (!name && item.getAttribute('aria-label')) {
          name = item.getAttribute('aria-label');
        }
        
        // Approach 2: Look for heading elements
        if (!name) {
          const heading = item.querySelector('h3, h2, h1, div[role="heading"]');
          if (heading) {
            name = heading.textContent.trim();
          }
        }
        
        // Approach 3: Look for any text content
        if (!name) {
          name = item.textContent.trim().split('\n')[0].trim();
        }
        
        // Only add if we found a name
        if (name) {
          listings.push({ 
            name,
            index: i // Store the index for navigation purposes
          });
        }
      } catch (err) {
        console.error('Error extracting listing:', err);
      }
    }
    
    return listings;
  }, limit);
}

// Function to extract detailed business information with more reliable selectors
async function extractBusinessDetails(page) {
  return await page.evaluate(() => {
    const details = {};
    
    // More robust name extraction
    const nameSelectors = [
      'h1.fontHeadlineLarge', 
      'div[role="main"] div[role="heading"]',
      'h1.DUwDvf',
      'h1.x3AX1-LfntMc-header-title-title',
      'div.x3AX1-LfntMc-header-title-title',
      'div.qBF1Pd-haAclf'
    ];
    
    for (const selector of nameSelectors) {
      const nameElement = document.querySelector(selector);
      if (nameElement) {
        details.name = nameElement.textContent.trim();
        break;
      }
    }
    
    // Extract address - multiple strategies
    const addressSelectors = [
      'button[data-item-id="address"]',
      'button[jsaction*="address"]',
      'button[aria-label*="Address"]',
      'button.CsEnBe[aria-label]',
      'div[role="button"][aria-label*="Address"]'
    ];
    
    details.address = 'N/A';
    for (const selector of addressSelectors) {
      const addressElement = document.querySelector(selector);
      if (addressElement) {
        const addressDiv = addressElement.querySelector('.Io6YTe');
        if (addressDiv) {
          details.address = addressDiv.textContent.trim();
          break;
        } else {
          details.address = addressElement.textContent.trim();
          break;
        }
      }
    }
    
    // Extract phone number - multiple strategies
    const phoneSelectors = [
      'button[data-item-id^="phone:tel:"]',
      'button[aria-label*="Phone"]',
      'div[role="button"][aria-label*="Phone"]',
      'a[data-item-id^="phone"]',
      'a[href^="tel:"]'
    ];
    
    details.phone = 'N/A';
    for (const selector of phoneSelectors) {
      const phoneElement = document.querySelector(selector);
      if (phoneElement) {
        const phoneDiv = phoneElement.querySelector('.Io6YTe');
        if (phoneDiv) {
          details.phone = phoneDiv.textContent.trim();
          break;
        } else if (phoneElement.href && phoneElement.href.startsWith('tel:')) {
          details.phone = phoneElement.href.replace('tel:', '');
          break;
        } else {
          details.phone = phoneElement.textContent.trim();
          break;
        }
      }
    }
    
    // Extract website - multiple strategies
    const websiteSelectors = [
      'a[data-item-id="authority"]',
      'a[aria-label*="website"]',
      'a[aria-label*="Website"]',
      'a[href^="https://"][data-item-id]',
      'div[role="button"][aria-label*="website"]'
    ];
    
    details.website = 'N/A';
    for (const selector of websiteSelectors) {
      const websiteElement = document.querySelector(selector);
      if (websiteElement) {
        const websiteDiv = websiteElement.querySelector('.Io6YTe');
        if (websiteDiv) {
          details.website = websiteDiv.textContent.trim();
          break;
        } else if (websiteElement.href && !websiteElement.href.includes('google.com')) {
          details.website = websiteElement.href;
          break;
        } else {
          details.website = websiteElement.textContent.trim();
          break;
        }
      }
    }
    
    // Extract rating - multiple approaches
    // Method 1: Look for specific rating containers
    const ratingSelectors = [
      'span.ceJTW', 
      'span.ODSEW-ShBeI-H1e3jb',
      'span[aria-hidden="true"][role="img"]',
      'div.F7nice',
      'span.iRCJncVPvXIc4GMcvvB9'
    ];
    
    details.rating = 'N/A';
    
    for (const selector of ratingSelectors) {
      const ratingElement = document.querySelector(selector);
      if (ratingElement && ratingElement.textContent) {
        const ratingText = ratingElement.textContent.trim();
        const ratingMatch = ratingText.match(/^\d(\.\d)?$/);
        if (ratingMatch) {
          details.rating = ratingText;
          break;
        }
      }
    }
    
    // Method 2: Look for patterns in spans
    if (details.rating === 'N/A') {
      const ratingSpans = Array.from(document.querySelectorAll('span'));
      const ratingSpan = ratingSpans.find(span => {
        const text = span.textContent.trim();
        return text.length <= 3 && text.match(/^\d(\.\d)?$/) && parseFloat(text) <= 5;
      });
      
      if (ratingSpan) {
        details.rating = ratingSpan.textContent.trim();
      }
    }
    
    // Extract reviews count - multiple approaches
    details.reviews = 'N/A';
    
    // Method 1: Look for review text near rating
    const reviewContainers = document.querySelectorAll('span.F7nice, div.F7nice, div.review-score');
    for (const container of reviewContainers) {
      const text = container.textContent;
      const reviewsMatch = text.match(/(\d{1,3}(?:,\d{3})*)\s*reviews?/i);
      if (reviewsMatch && reviewsMatch[1]) {
        details.reviews = reviewsMatch[1];
        break;
      }
    }
    
    // Method 2: Parse the entire body text
    if (details.reviews === 'N/A') {
      const pageText = document.body.innerText;
      const reviewsMatches = [
        pageText.match(/(\d{1,3}(?:,\d{3})*)\s*reviews?/i),
        pageText.match(/reviews?[^0-9]*(\d{1,3}(?:,\d{3})*)/i)
      ];
      
      for (const match of reviewsMatches) {
        if (match && match[1]) {
          details.reviews = match[1];
          break;
        }
      }
    }
    
    // Extract business hours - multiple approaches
    const hoursData = [];
    
    // Method 1: Look for the hours table
    const hoursTableSelectors = [
      'table.eK4R0e', 
      'table.WgFkxc', 
      'div[role="region"][aria-label*="hour"]'
    ];
    
    let foundHours = false;
    
    for (const selector of hoursTableSelectors) {
      const hoursTable = document.querySelector(selector);
      if (hoursTable) {
        const rows = hoursTable.querySelectorAll('tr.y0skZc, tr');
        rows.forEach(row => {
          const day = row.querySelector('.ylH6lf, .x4hIce')?.textContent.trim();
          const hours = row.querySelector('.mxowUb, .G8aQO')?.textContent.trim();
          
          if (day && hours) {
            hoursData.push(`${day}: ${hours}`);
            foundHours = true;
          }
        });
        
        if (foundHours) {
          details.hours = hoursData.join('; ');
          break;
        }
      }
    }
    
    // Method 2: Look for an hours section
    if (!foundHours) {
      const hoursSelectors = ['.OMl5r', '.VaxuYe', '.G8aQO', '[aria-label*="hour"]'];
      for (const selector of hoursSelectors) {
        const hoursSection = document.querySelector(selector);
        if (hoursSection) {
          details.hours = hoursSection.textContent.trim();
          foundHours = true;
          break;
        }
      }
    }
    
    if (!foundHours) {
      details.hours = 'N/A';
    }
    
    // Try to find email - this is challenging as emails are rarely directly available
    const pageText = document.body.innerText;
    const emailRegex = /[\w.-]+@[\w.-]+\.\w+/;
    const emailMatch = pageText.match(emailRegex);
    details.email = emailMatch ? emailMatch[0] : 'N/A';
    
    // Extract business category - try multiple approaches
    let category = 'N/A';
    
    // Method 1: Look for category links
    const categorySelectors = [
      'a.CsEnBe', 
      'button[jsaction*="pane.rating.category"]',
      'button.DkEaL',
      'span[jsaction*="category"]',
      'button[aria-label*="categor"]'
    ];
    
    for (const selector of categorySelectors) {
      const elements = document.querySelectorAll(selector);
      elements.forEach(element => {
        const text = element.textContent.trim();
        if (text && text.length < 30 && !text.includes('http') && !text.includes('@') && !text.match(/^\d/) &&
            text !== "Menu" && text !== details.website && !text.includes("Phone:")) {
          category = text;
        }
      });
      
      if (category !== 'N/A') break;
    }
    
    // Method 2: Look for category in main content
    if (category === 'N/A') {
      const categoryTextMatches = [
        pageText.match(/Category:\s*([^.,;]+)/i),
        pageText.match(/Type:\s*([^.,;]+)/i)
      ];
      
      for (const match of categoryTextMatches) {
        if (match && match[1]) {
          category = match[1].trim();
          break;
        }
      }
    }
    
    details.category = category;
    
    // Extract additional attributes (LGBTQ+ friendly, Latino-owned, etc.)
    const attributes = [];
    const attributeSelectors = [
      '.RcCsl .AeaXub .Io6YTe span',
      '.ggc0ld .Io6YTe',
      '.q5X0Ue',
      'div.PODJx'
    ];
    
    for (const selector of attributeSelectors) {
      const attributeElements = document.querySelectorAll(selector);
      attributeElements.forEach(attr => {
        const text = attr.textContent.trim();
        if (text && text !== details.name && text !== details.address && 
            text !== details.phone && text !== details.website &&
            text !== category && text.length < 50) {
          attributes.push(text);
        }
      });
    }
    
    if (attributes.length > 0) {
      details.attributes = attributes.join(', ');
    }
    
    // Extract price range if available
    const priceSelectors = [
      '.MNVeJb',
      'span.mgr77e',
      'span[aria-label*="Price"]'
    ];
    
    for (const selector of priceSelectors) {
      const priceElement = document.querySelector(selector);
      if (priceElement) {
        details.priceRange = priceElement.textContent.trim().split('Reported by')[0].trim();
        break;
      }
    }
    
    return details;
  });
}

// Helper function to scroll down and load more results
async function autoScroll(page) {
  await page.evaluate(async () => {
    // Try different selectors for the feed
    const feedSelectors = [
      'div[role="feed"]',
      'div.m6QErb[role="region"]',
      'div.m6QErb',
      'div.section-scrollbox',
      'div.ecceSd'
    ];
    
    let feed = null;
    for (const selector of feedSelectors) {
      const element = document.querySelector(selector);
      if (element) {
        feed = element;
        break;
      }
    }
    
    if (!feed) return;
    
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 300; // Increased scroll distance
      const timer = setInterval(() => {
        const scrollHeight = feed.scrollHeight;
        feed.scrollBy(0, distance);
        totalHeight += distance;
        
        // Resolve after a reasonable amount of scrolling
        if (totalHeight >= scrollHeight || totalHeight > 6000) {
          clearInterval(timer);
          resolve();
        }
      }, 200); // Slightly slower scrolling for better loading
    });
  });
  
  // Wait for new elements to load
  await page.waitForTimeout(3000);
}

// Export data to Excel
async function exportToExcel(data) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Google Maps Data');
  
  const columns = [
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Address', key: 'address', width: 40 },
    { header: 'Phone', key: 'phone', width: 20 },
    { header: 'Website', key: 'website', width: 30 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Rating', key: 'rating', width: 10 },
    { header: 'Reviews', key: 'reviews', width: 10 },
    { header: 'Hours', key: 'hours', width: 40 },
    { header: 'Category', key: 'category', width: 20 },
    { header: 'Price Range', key: 'priceRange', width: 15 },
    { header: 'Attributes', key: 'attributes', width: 30 }
  ];
  
  worksheet.columns = columns;
  
  // Add style to header row
  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF4F81BD' }
  };
  worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).font = { color: { argb: 'FFFFFFFF' } };
  
  // Add rows
  worksheet.addRows(data);
  
  // Auto filter
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length }
  };
  
  // Return as buffer
  return await workbook.xlsx.writeBuffer();
}

// Export data to CSV
function exportToCSV(data) {
  try {
    const fields = ['name', 'address', 'phone', 'website', 'email', 'rating', 'reviews', 'hours', 'category'];
    const parser = new Parser({ fields });
    return parser.parse(data);
  } catch (error) {
    console.error('CSV Export Error:', error);
    throw error;
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
});