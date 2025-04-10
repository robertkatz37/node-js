// server.js - Main Express application optimized for Vercel serverless
const express = require('express');
const cors = require('cors');
const path = require('path');
const ExcelJS = require('exceljs');
const { Parser } = require('json2csv');

// Import chrome-aws-lambda and puppeteer-core for Vercel compatibility
const chromium = require('chrome-aws-lambda');
const puppeteerCore = require('puppeteer-core');

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
// Modified to use chrome-aws-lambda for Vercel compatibility
async function scrapeGoogleMaps(searchQuery, limit) {
  let browser = null;
  
  try {
    console.log(`Starting Google Maps scraping for: ${searchQuery}`);
    
    // Launch browser using chrome-aws-lambda for Vercel serverless compatibility
    browser = await puppeteerCore.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });
    
    // Create a new page for the initial search
    const searchPage = await browser.newPage();
    
    // Set a realistic user agent
    await searchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36');
    
    // Add extra headers to look more like a real browser
    await searchPage.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Referer': 'https://www.google.com/'
    });
    
    // Enable request interception for better performance
    await searchPage.setRequestInterception(true);
    searchPage.on('request', (req) => {
      // Skip loading images, fonts and stylesheets for better performance
      const resourceType = req.resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`Navigating to Google Maps and searching for: ${searchQuery}`);
    await searchPage.goto('https://www.google.com/maps', { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Find and type in the search box
    await searchPage.waitForSelector('#searchboxinput', { timeout: 15000 });
    await searchPage.type('#searchboxinput', searchQuery);
    
    // Add a small delay between typing and pressing Enter to mimic human behavior
    await randomDelay(searchPage, 800, 2000);
    
    await searchPage.keyboard.press('Enter');
    
    // Wait for search results to load completely
    console.log('Waiting for search results to load...');
    await searchPage.waitForTimeout(8000);
    
    // Scroll to load more results until we have the required number of listings URLs
    console.log(`Scrolling to load at least ${limit} results...`);
    
    // Get listing URLs with names from search results
    const listingUrls = await collectListingUrls(searchPage, limit);
    console.log(`Collected ${listingUrls.length} business listing URLs`);
    
    // Now visit each URL and scrape the details
    const detailedData = [];
    
    for (let i = 0; i < listingUrls.length; i++) {
      try {
        const { name, url } = listingUrls[i];
        console.log(`Processing business ${i+1}/${listingUrls.length}: ${name}`);
        
        // Create a new page for each listing
        const detailPage = await browser.newPage();
        
        // Configure the detail page
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36');
        await detailPage.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Referer': 'https://www.google.com/maps'
        });
        
        // Enable request interception
        await detailPage.setRequestInterception(true);
        detailPage.on('request', (req) => {
          const resourceType = req.resourceType();
          if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
            req.abort();
          } else {
            req.continue();
          }
        });
        
        // Navigate to listing URL
        console.log(`Navigating to URL: ${url}`);
        await detailPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Wait for details panel to load
        console.log('Waiting for business details to load...');
        await detailPage.waitForTimeout(8000);
        
        // Extract detailed info
        console.log('Extracting detailed business information...');
        const detailedInfo = await extractBusinessDetails(detailPage);
        
        // Combine basic and detailed info
        detailedData.push({
          name,
          ...detailedInfo
        });
        
        // Close the detail page to free up resources
        await detailPage.close();
        
        // Add some delay between businesses
        await randomDelay(searchPage, 2000, 5000);
        
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
    if (browser !== null) {
      await browser.close();
    }
  }
}

// Improved function to collect all listing URLs from search results
async function collectListingUrls(page, limit) {
  const listingUrls = [];
  let previousUrlCount = 0;
  let scrollAttempts = 0;
  const maxScrollAttempts = 30; // Increased max scroll attempts
  let consecutiveNoNewUrls = 0;
  const maxConsecutiveNoNewUrls = 5; // Stop after 5 consecutive scrolls with no new URLs
  
  while (listingUrls.length < limit && scrollAttempts < maxScrollAttempts && 
         consecutiveNoNewUrls < maxConsecutiveNoNewUrls) {
    
    previousUrlCount = listingUrls.length;
    
    // Wait for a moment to ensure all elements have loaded
    await page.waitForTimeout(2000);
    
    // Extract URLs currently visible
    const newUrls = await page.evaluate(() => {
      const results = [];
      // Get all listing links - checking multiple selectors for better reliability
      const listingLinkSelectors = [
        'a.hfpxzc', 
        '.Nv2PK a[href*="/maps/place/"]',
        'div[role="article"] a[data-value]',
        'a[jsaction*="mouseup"]',
        'a[aria-label][href*="/maps/place/"]'
      ];
      
      let listingLinks = [];
      for (const selector of listingLinkSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          listingLinks = elements;
          break;
        }
      }
      
      listingLinks.forEach(link => {
        const url = link.href;
        
        // Try to extract name from different attributes
        let name = link.getAttribute('aria-label');
        
        if (!name) {
          // Try to find name in nearby elements
          const nearbyHeading = link.closest('div').querySelector('div[role="heading"], h3, h2, h1');
          if (nearbyHeading) {
            name = nearbyHeading.textContent.trim();
          } else {
            // Use some content from the link or its parent
            name = (link.textContent || link.closest('div').textContent || '').trim();
            // Limit to first line if multiple lines
            name = name.split('\n')[0].trim();
          }
        }
        
        // Only add if we have both URL and name
        if (url && name && url.includes('/maps/place/')) {
          results.push({ name, url });
        }
      });
      
      return results;
    });
    
    // Add new unique URLs to our collection
    let addedNewUrls = false;
    for (const item of newUrls) {
      // Check if URL already exists in listingUrls array
      if (!listingUrls.some(existing => existing.url === item.url)) {
        listingUrls.push(item);
        addedNewUrls = true;
        if (listingUrls.length >= limit) break;
      }
    }
    
    console.log(`Found ${listingUrls.length}/${limit} URLs after scroll #${scrollAttempts + 1}`);
    
    // Track if we found new URLs
    if (addedNewUrls) {
      consecutiveNoNewUrls = 0;
    } else {
      consecutiveNoNewUrls++;
      console.log(`No new URLs found for ${consecutiveNoNewUrls} consecutive scrolls`);
    }
    
    // Scroll to load more results if needed
    if (listingUrls.length < limit) {
      await improvedAutoScroll(page);
      scrollAttempts++;
      
      // Wait longer after each scroll to ensure results load
      const waitTime = 3000 + (scrollAttempts * 500); // Gradually increase wait time
      await page.waitForTimeout(waitTime);
    }
  }
  
  // Return only up to the limit requested
  return listingUrls.slice(0, limit);
}

// Improved auto scroll function with better detection of scrollable elements
async function improvedAutoScroll(page) {
  return await page.evaluate(async () => {
    // Try different selectors for the scrollable container
    const scrollableSelectors = [
      'div[role="feed"]',
      'div.m6QErb[role="region"]',
      'div.m6QErb',
      'div.section-scrollbox',
      'div.ecceSd',
      '.m6QErb-tempH0gTDc',
      '.DxyBCb',
      '.kA9KIf',
      '[aria-label="Results for"]',
      'div[jsaction*="scroll"]'
    ];
    
    let scrollableElement = null;
    
    // Find the first valid scrollable element
    for (const selector of scrollableSelectors) {
      const element = document.querySelector(selector);
      if (element && element.scrollHeight > element.clientHeight) {
        scrollableElement = element;
        break;
      }
    }
    
    // If no specific element found, try the document body
    if (!scrollableElement) {
      scrollableElement = document.scrollingElement || document.documentElement;
    }
    
    const scrollHeight = scrollableElement.scrollHeight;
    const windowHeight = window.innerHeight || scrollableElement.clientHeight;
    const scrollDistance = windowHeight * 0.7; // Scroll 70% of visible window
    
    // Starting position
    const startY = scrollableElement.scrollTop;
    const endY = Math.min(startY + scrollDistance, scrollHeight - windowHeight);
    
    // Smooth scroll in small steps
    const steps = 15;
    const stepSize = (endY - startY) / steps;
    
    for (let i = 1; i <= steps; i++) {
      scrollableElement.scrollTop = startY + (stepSize * i);
      // Small pause between each scroll step
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    return true; // Return success
  });
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
    const fields = ['name', 'address', 'phone', 'website', 'email', 'rating', 'reviews', 'hours', 'category', 'priceRange', 'attributes'];
    const parser = new Parser({ fields });
    return parser.parse(data);
  } catch (error) {
    console.error('CSV Export Error:', error);
    throw error;
  }
}

// Add serverless function handler for Vercel
module.exports = app;

// Only start the server in development, not needed for Vercel deployment
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
  });
}
