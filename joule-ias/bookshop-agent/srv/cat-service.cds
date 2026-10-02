@agent @odata service CatalogService {
  entity Books { 
    key ID:Integer; title:String; author:String;
  }

  action submitOrder (bookId: Integer);

  function getProfileInfo() returns String;
} 
