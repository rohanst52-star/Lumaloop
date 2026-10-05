const lamp = require('../assets/images/lumaloop-lamp.jpg');
const bag = require('../assets/images/lumaloop-bag.jpg');
const home = require('../assets/images/lumaloop-home.jpg');

export const localImages = { lamp, bag, home };
export const categoryCatalog = [
  { id: 'home', name: 'Home', image: home, icon: 'home', blurb: 'Spaces with soul' },
  { id: 'fashion', name: 'Fashion', image: bag, icon: 'shopping-bag', blurb: 'Wear it well' },
  { id: 'accessories', name: 'Accessories', image: bag, icon: 'watch', blurb: 'Small good things' },
  { id: 'books', name: 'Books', image: home, icon: 'book-open', blurb: 'Ideas to keep' },
  { id: 'tech', name: 'Tech', image: lamp, icon: 'headphones', blurb: 'Better by design' },
  { id: 'kids', name: 'Kids', image: home, icon: 'smile', blurb: 'Little treasures' },
  { id: 'collectibles', name: 'Collectibles', image: lamp, icon: 'star', blurb: 'For the curious' },
  { id: 'wellness', name: 'Wellness', image: bag, icon: 'sun', blurb: 'Slow down here' },
] as const;